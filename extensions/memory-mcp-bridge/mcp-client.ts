/**
 * Memory MCP Client
 *
 * Communicates with the Claude Code++ Memory MCP server via stdio JSON-RPC.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { MemoryMcpConfig } from "./config.js";
import { mapCategoryToType, mapTypeToCategory, type OpenClawCategory } from "./config.js";

// ============================================================================
// Types
// ============================================================================

export interface MemoryEntry {
  id: string;
  content: string;
  type: string;
  category: OpenClawCategory;
  importance: number;
  tags: string[];
  created_at: string;
  score?: number;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ============================================================================
// MCP Client
// ============================================================================

export class MemoryMcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private initialized = false;
  private pendingRequests = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private buffer = "";
  private initPromise: Promise<void> | null = null;

  constructor(private readonly config: MemoryMcpConfig) {
    super();
  }

  /**
   * Initialize the MCP connection
   */
  async connect(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doConnect();
    return this.initPromise;
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.config.mcpCommand, this.config.mcpArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        this.process.stdout?.on("data", (data) => this.handleData(data));
        this.process.stderr?.on("data", (data) => {
          // Log stderr but don't fail
          this.emit("error", new Error(`MCP stderr: ${data.toString()}`));
        });

        this.process.on("error", (err) => {
          this.emit("error", err);
          if (!this.initialized) {
            reject(err);
          }
        });

        this.process.on("close", (code) => {
          this.initialized = false;
          this.emit("close", code);
        });

        // Send initialize request
        this.sendRequest("initialize", {
          protocolVersion: "0.1.0",
          capabilities: {},
          clientInfo: { name: "openclaw-memory-bridge", version: "1.0.0" },
        })
          .then(() => {
            this.initialized = true;
            resolve();
          })
          .catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Disconnect from the MCP server
   */
  disconnect(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.initialized = false;
    this.pendingRequests.clear();
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // Process complete JSON-RPC messages
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {
        // Ignore parse errors for incomplete messages
      }
    }
  }

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin) {
      throw new Error("MCP process not connected");
    }

    const id = randomUUID();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + "\n");

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error("MCP request timeout"));
        }
      }, 30000);
    });
  }

  /**
   * Call an MCP tool
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return this.sendRequest("tools/call", { name, arguments: args });
  }

  // ========================================================================
  // Memory Operations
  // ========================================================================

  /**
   * Store a memory
   */
  async store(
    content: string,
    category: OpenClawCategory = "other",
    importance: number = 0.7,
    tags: string[] = []
  ): Promise<MemoryEntry> {
    const type = mapCategoryToType(category);

    // Add category as a tag for filtering
    const allTags = [...tags, category];

    const result = (await this.callTool("memory_store", {
      content,
      type,
      importance,
      tags: allTags,
    })) as { content: Array<{ text: string }>; details?: { id?: string } };

    return {
      id: result.details?.id || randomUUID(),
      content,
      type,
      category,
      importance,
      tags: allTags,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Search memories
   */
  async search(query: string, limit: number = 5, minScore: number = 0.3): Promise<MemoryEntry[]> {
    const result = (await this.callTool("memory_search", {
      query,
      limit,
      tier: "all",
    })) as { content: Array<{ text: string }>; details?: { results?: Array<Record<string, unknown>> } };

    const memories = result.details?.results || [];

    return memories.map((m) => ({
      id: String(m.id || ""),
      content: String(m.content || m.text || ""),
      type: String(m.type || "note"),
      category: mapTypeToCategory(String(m.type || "note")),
      importance: Number(m.importance) || 0.5,
      tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
      created_at: String(m.created_at || new Date().toISOString()),
      score: Number(m.score) || 0,
    })).filter((m) => (m.score || 0) >= minScore);
  }

  /**
   * Delete a memory
   */
  async delete(memoryId: string): Promise<boolean> {
    await this.callTool("memory_delete", { memory_id: memoryId });
    return true;
  }

  /**
   * List memories
   */
  async list(type?: string, limit: number = 20): Promise<MemoryEntry[]> {
    const result = (await this.callTool("memory_list", {
      type,
      limit,
    })) as { content: Array<{ text: string }>; details?: { memories?: Array<Record<string, unknown>> } };

    const memories = result.details?.memories || [];

    return memories.map((m) => ({
      id: String(m.id || ""),
      content: String(m.content || m.text || ""),
      type: String(m.type || "note"),
      category: mapTypeToCategory(String(m.type || "note")),
      importance: Number(m.importance) || 0.5,
      tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
      created_at: String(m.created_at || new Date().toISOString()),
    }));
  }

  /**
   * Get memory statistics
   */
  async stats(): Promise<Record<string, unknown>> {
    const result = (await this.callTool("memory_stats", {})) as {
      content: Array<{ text: string }>;
      details?: Record<string, unknown>;
    };
    return result.details || {};
  }
}
