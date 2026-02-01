/**
 * OpenClaw Memory MCP Bridge Plugin
 *
 * Replaces the LanceDB memory plugin with Claude Code++ Memory MCP integration.
 * Provides the same auto-recall and auto-capture hooks, but routes all memory
 * operations through the tiered Memory MCP server (Redis → Graphiti → SQLite → Vault).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk";
import { MemoryMcpClient, type MemoryEntry } from "./mcp-client.js";
import {
  memoryMcpConfigSchema,
  OPENCLAW_CATEGORIES,
  type OpenClawCategory,
  mapTypeToCategory,
} from "./config.js";

// ============================================================================
// Rule-based capture filter (same as LanceDB version for compatibility)
// ============================================================================

const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /rozhodli jsme|budeme používat/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /můj\s+\w+\s+je|je\s+můj/i,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
];

function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > 500) {
    return false;
  }
  // Skip injected context from memory recall
  if (text.includes("<relevant-memories>")) {
    return false;
  }
  // Skip system-generated content
  if (text.startsWith("<") && text.includes("</")) {
    return false;
  }
  // Skip agent summary responses (contain markdown formatting)
  if (text.includes("**") && text.includes("\n-")) {
    return false;
  }
  // Skip emoji-heavy responses (likely agent output)
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

function detectCategory(text: string): OpenClawCategory {
  const lower = text.toLowerCase();
  if (/prefer|radši|like|love|hate|want/i.test(lower)) {
    return "preference";
  }
  if (/rozhodli|decided|will use|budeme/i.test(lower)) {
    return "decision";
  }
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se/i.test(lower)) {
    return "entity";
  }
  if (/is|are|has|have|je|má|jsou/i.test(lower)) {
    return "fact";
  }
  return "other";
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryMcpBridgePlugin = {
  id: "memory-mcp-bridge",
  name: "Memory (MCP Bridge)",
  description: "Claude Code++ Memory MCP integration with tiered storage",
  kind: "memory" as const,
  configSchema: memoryMcpConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = memoryMcpConfigSchema.parse(api.pluginConfig);
    const client = new MemoryMcpClient(cfg);

    api.logger.info(`memory-mcp-bridge: plugin registered (command: ${cfg.mcpCommand})`);

    // Handle client errors
    client.on("error", (err) => {
      api.logger.warn(`memory-mcp-bridge: ${String(err)}`);
    });

    client.on("close", (code) => {
      api.logger.info(`memory-mcp-bridge: MCP process closed with code ${code}`);
    });

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 5 } = params as { query: string; limit?: number };

          try {
            const results = await client.search(query, limit, cfg.recallMinScore);

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            const text = results
              .map(
                (r, i) =>
                  `${i + 1}. [${r.category}] ${r.content} (${((r.score || 0) * 100).toFixed(0)}%)`
              )
              .join("\n");

            // Sanitize for serialization
            const sanitizedResults = results.map((r) => ({
              id: r.id,
              text: r.content,
              category: r.category,
              importance: r.importance,
              score: r.score,
            }));

            return {
              content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
              details: { count: results.length, memories: sanitizedResults },
            };
          } catch (err) {
            api.logger.warn(`memory_recall error: ${String(err)}`);
            return {
              content: [{ type: "text", text: "Memory recall failed. MCP server may be unavailable." }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_recall" }
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save important information in long-term memory. Use for preferences, facts, decisions.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          importance: Type.Optional(Type.Number({ description: "Importance 0-1 (default: 0.7)" })),
          category: Type.Optional(stringEnum(OPENCLAW_CATEGORIES)),
        }),
        async execute(_toolCallId, params) {
          const {
            text,
            importance = 0.7,
            category = "other",
          } = params as {
            text: string;
            importance?: number;
            category?: OpenClawCategory;
          };

          try {
            // Check for duplicates first
            const existing = await client.search(text, 1, 0.95);
            if (existing.length > 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Similar memory already exists: "${existing[0].content}"`,
                  },
                ],
                details: {
                  action: "duplicate",
                  existingId: existing[0].id,
                  existingText: existing[0].content,
                },
              };
            }

            const entry = await client.store(text, category, importance);

            return {
              content: [{ type: "text", text: `Stored: "${text.slice(0, 100)}..."` }],
              details: { action: "created", id: entry.id },
            };
          } catch (err) {
            api.logger.warn(`memory_store error: ${String(err)}`);
            return {
              content: [{ type: "text", text: "Memory store failed. MCP server may be unavailable." }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_store" }
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete specific memories. GDPR-compliant.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search to find memory" })),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
        }),
        async execute(_toolCallId, params) {
          const { query, memoryId } = params as { query?: string; memoryId?: string };

          try {
            if (memoryId) {
              await client.delete(memoryId);
              return {
                content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
                details: { action: "deleted", id: memoryId },
              };
            }

            if (query) {
              const results = await client.search(query, 5, 0.7);

              if (results.length === 0) {
                return {
                  content: [{ type: "text", text: "No matching memories found." }],
                  details: { found: 0 },
                };
              }

              if (results.length === 1 && (results[0].score || 0) > 0.9) {
                await client.delete(results[0].id);
                return {
                  content: [{ type: "text", text: `Forgotten: "${results[0].content}"` }],
                  details: { action: "deleted", id: results[0].id },
                };
              }

              const list = results
                .map((r) => `- [${r.id.slice(0, 8)}] ${r.content.slice(0, 60)}...`)
                .join("\n");

              const sanitizedCandidates = results.map((r) => ({
                id: r.id,
                text: r.content,
                category: r.category,
                score: r.score,
              }));

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                  },
                ],
                details: { action: "candidates", candidates: sanitizedCandidates },
              };
            }

            return {
              content: [{ type: "text", text: "Provide query or memoryId." }],
              details: { error: "missing_param" },
            };
          } catch (err) {
            api.logger.warn(`memory_forget error: ${String(err)}`);
            return {
              content: [{ type: "text", text: "Memory forget failed." }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_forget" }
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const memory = program.command("memory").description("Memory MCP Bridge commands");

        memory
          .command("list")
          .description("List memories")
          .option("--type <type>", "Filter by type")
          .option("--limit <n>", "Max results", "20")
          .action(async (opts) => {
            try {
              const memories = await client.list(opts.type, parseInt(opts.limit));
              console.log(`Total memories: ${memories.length}`);
              for (const m of memories) {
                console.log(`  [${m.category}] ${m.content.slice(0, 60)}...`);
              }
            } catch (err) {
              console.error(`Error: ${String(err)}`);
            }
          });

        memory
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query, opts) => {
            try {
              const results = await client.search(query, parseInt(opts.limit));
              console.log(JSON.stringify(results, null, 2));
            } catch (err) {
              console.error(`Error: ${String(err)}`);
            }
          });

        memory
          .command("stats")
          .description("Show memory statistics")
          .action(async () => {
            try {
              const stats = await client.stats();
              console.log(JSON.stringify(stats, null, 2));
            } catch (err) {
              console.error(`Error: ${String(err)}`);
            }
          });
      },
      { commands: ["memory"] }
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) {
          return;
        }

        try {
          const results = await client.search(event.prompt, cfg.recallLimit, cfg.recallMinScore);

          if (results.length === 0) {
            return;
          }

          const memoryContext = results
            .map((r) => `- [${r.category}] ${r.content}`)
            .join("\n");

          api.logger.info?.(`memory-mcp-bridge: injecting ${results.length} memories into context`);

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-mcp-bridge: recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: analyze and store important information after agent ends
    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          // Extract text content from messages
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") {
              continue;
            }
            const msgObj = msg as Record<string, unknown>;

            // Only process user and assistant messages
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") {
              continue;
            }

            const content = msgObj.content;

            // Handle string content directly
            if (typeof content === "string") {
              texts.push(content);
              continue;
            }

            // Handle array content (content blocks)
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  texts.push((block as Record<string, unknown>).text as string);
                }
              }
            }
          }

          // Filter for capturable content
          const toCapture = texts.filter((text) => text && shouldCapture(text));
          if (toCapture.length === 0) {
            return;
          }

          // Store each capturable piece (limit to 3 per conversation)
          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            const category = detectCategory(text);

            // Check for duplicates (high similarity threshold)
            const existing = await client.search(text, 1, 0.95);
            if (existing.length > 0) {
              continue;
            }

            await client.store(text, category, 0.7);
            stored++;
          }

          if (stored > 0) {
            api.logger.info(`memory-mcp-bridge: auto-captured ${stored} memories`);
          }
        } catch (err) {
          api.logger.warn(`memory-mcp-bridge: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-mcp-bridge",
      start: async () => {
        try {
          await client.connect();
          api.logger.info(
            `memory-mcp-bridge: initialized (command: ${cfg.mcpCommand})`
          );
        } catch (err) {
          api.logger.warn(`memory-mcp-bridge: failed to connect: ${String(err)}`);
        }
      },
      stop: () => {
        client.disconnect();
        api.logger.info("memory-mcp-bridge: stopped");
      },
    });
  },
};

export default memoryMcpBridgePlugin;
