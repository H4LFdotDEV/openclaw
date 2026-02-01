/**
 * Memory MCP Bridge Configuration
 *
 * Configuration for connecting OpenClaw to the Claude Code++ Memory MCP server.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryMcpConfig = {
  /** Path to the memory-mcp wrapper script */
  mcpCommand: string;
  /** Arguments to pass to the MCP command */
  mcpArgs: string[];
  /** Enable auto-recall before agent starts */
  autoRecall: boolean;
  /** Enable auto-capture after agent ends */
  autoCapture: boolean;
  /** Maximum memories to recall per query */
  recallLimit: number;
  /** Minimum similarity score for recall (0-1) */
  recallMinScore: number;
};

/**
 * OpenClaw categories mapped to Memory MCP types
 */
export const CATEGORY_MAPPING = {
  preference: "preference",
  decision: "decision",
  entity: "reference",
  fact: "reference",
  other: "note",
} as const;

export type OpenClawCategory = keyof typeof CATEGORY_MAPPING;
export type MemoryMcpType = (typeof CATEGORY_MAPPING)[OpenClawCategory];

export const OPENCLAW_CATEGORIES = Object.keys(CATEGORY_MAPPING) as OpenClawCategory[];

/**
 * Map OpenClaw category to Memory MCP type
 */
export function mapCategoryToType(category: OpenClawCategory): MemoryMcpType {
  return CATEGORY_MAPPING[category] || "note";
}

/**
 * Reverse map Memory MCP type back to closest OpenClaw category
 */
export function mapTypeToCategory(type: string): OpenClawCategory {
  switch (type) {
    case "preference":
      return "preference";
    case "decision":
      return "decision";
    case "reference":
      return "entity";
    case "note":
    default:
      return "other";
  }
}

function resolveDefaultMcpCommand(): string {
  const home = homedir();
  return join(home, ".claude-code-pp", "bin", "memory-mcp");
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export const memoryMcpConfigSchema = {
  parse(value: unknown): MemoryMcpConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      // Return defaults if no config provided
      return {
        mcpCommand: resolveDefaultMcpCommand(),
        mcpArgs: [],
        autoRecall: true,
        autoCapture: true,
        recallLimit: 5,
        recallMinScore: 0.3,
      };
    }

    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["mcpCommand", "mcpArgs", "autoRecall", "autoCapture", "recallLimit", "recallMinScore"],
      "memory-mcp config"
    );

    return {
      mcpCommand: typeof cfg.mcpCommand === "string" ? cfg.mcpCommand : resolveDefaultMcpCommand(),
      mcpArgs: Array.isArray(cfg.mcpArgs) ? cfg.mcpArgs.map(String) : [],
      autoRecall: cfg.autoRecall !== false,
      autoCapture: cfg.autoCapture !== false,
      recallLimit: typeof cfg.recallLimit === "number" ? cfg.recallLimit : 5,
      recallMinScore: typeof cfg.recallMinScore === "number" ? cfg.recallMinScore : 0.3,
    };
  },

  uiHints: {
    mcpCommand: {
      label: "MCP Command",
      placeholder: "~/.claude-code-pp/bin/memory-mcp",
      advanced: true,
      help: "Path to the Memory MCP server wrapper script",
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context",
    },
    recallLimit: {
      label: "Recall Limit",
      placeholder: "5",
      advanced: true,
      help: "Maximum number of memories to recall per query",
    },
    recallMinScore: {
      label: "Minimum Score",
      placeholder: "0.3",
      advanced: true,
      help: "Minimum similarity score for memory recall (0-1)",
    },
  },
};
