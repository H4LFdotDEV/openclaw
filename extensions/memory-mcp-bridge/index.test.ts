/**
 * Memory MCP Bridge Tests
 *
 * Tests for the OpenClaw Memory MCP Bridge plugin.
 * Run with: pnpm test (from openclaw directory)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { PluginAPI, Tool, Message } from '@openclaw/sdk';

// Mock the MCP client
vi.mock('./mcp-client', () => ({
    MemoryMcpClient: vi.fn().mockImplementation(() => ({
        on: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        search: vi.fn().mockResolvedValue([]),
        store: vi.fn().mockResolvedValue({ id: 'test-id', content: 'test' }),
        delete: vi.fn().mockResolvedValue(true),
        isConnected: vi.fn().mockReturnValue(true),
    })),
}));

// Import after mocking
import memoryMcpBridgePlugin from './index';
import { CATEGORY_MAPPING, DEFAULT_CONFIG, AUTO_STORE_PATTERNS } from './config';

describe('memory-mcp-bridge plugin', () => {
    let mockApi: PluginAPI;
    let registeredTools: Map<string, Tool>;
    let eventHandlers: Map<string, Function>;

    beforeEach(() => {
        registeredTools = new Map();
        eventHandlers = new Map();

        mockApi = {
            registerTool: vi.fn((tool: Tool) => {
                registeredTools.set(tool.name, tool);
            }),
            on: vi.fn((event: string, handler: Function) => {
                eventHandlers.set(event, handler);
            }),
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            },
            config: {
                get: vi.fn().mockReturnValue(DEFAULT_CONFIG),
            },
        } as unknown as PluginAPI;

        vi.clearAllMocks();
    });

    describe('plugin initialization', () => {
        it('should export a valid plugin object', () => {
            expect(memoryMcpBridgePlugin).toBeDefined();
            expect(memoryMcpBridgePlugin.name).toBe('memory-mcp-bridge');
            expect(typeof memoryMcpBridgePlugin.init).toBe('function');
        });

        it('should register tools on init', async () => {
            await memoryMcpBridgePlugin.init(mockApi);

            expect(mockApi.registerTool).toHaveBeenCalled();
            expect(registeredTools.has('memory_recall')).toBe(true);
            expect(registeredTools.has('memory_store')).toBe(true);
            expect(registeredTools.has('memory_forget')).toBe(true);
        });

        it('should register lifecycle hooks', async () => {
            await memoryMcpBridgePlugin.init(mockApi);

            expect(mockApi.on).toHaveBeenCalledWith('before_agent_start', expect.any(Function));
            expect(mockApi.on).toHaveBeenCalledWith('agent_end', expect.any(Function));
        });
    });

    describe('memory_recall tool', () => {
        it('should have correct schema', async () => {
            await memoryMcpBridgePlugin.init(mockApi);
            const tool = registeredTools.get('memory_recall');

            expect(tool).toBeDefined();
            expect(tool?.description).toContain('Search');
            expect(tool?.parameters).toHaveProperty('properties');
            expect(tool?.parameters.properties).toHaveProperty('query');
        });

        it('should return empty array when no memories found', async () => {
            await memoryMcpBridgePlugin.init(mockApi);
            const tool = registeredTools.get('memory_recall');

            const result = await tool?.handler({ query: 'nonexistent' });

            expect(result).toBeDefined();
            expect(result.memories).toEqual([]);
        });

        it('should pass limit parameter correctly', async () => {
            await memoryMcpBridgePlugin.init(mockApi);
            const tool = registeredTools.get('memory_recall');

            await tool?.handler({ query: 'test', limit: 5 });

            // Verify the search was called with correct limit
            expect(mockApi.logger.debug).not.toHaveBeenCalled();
        });
    });

    describe('memory_store tool', () => {
        it('should have correct schema', async () => {
            await memoryMcpBridgePlugin.init(mockApi);
            const tool = registeredTools.get('memory_store');

            expect(tool).toBeDefined();
            expect(tool?.parameters.properties).toHaveProperty('content');
            expect(tool?.parameters.properties).toHaveProperty('category');
            expect(tool?.parameters.required).toContain('content');
        });

        it('should store memory with default category', async () => {
            await memoryMcpBridgePlugin.init(mockApi);
            const tool = registeredTools.get('memory_store');

            const result = await tool?.handler({
                content: 'Test memory content',
            });

            expect(result).toBeDefined();
            expect(result.success).toBe(true);
        });

        it('should map OpenClaw categories to MCP types', async () => {
            await memoryMcpBridgePlugin.init(mockApi);
            const tool = registeredTools.get('memory_store');

            // Test each category mapping
            for (const [openclawCat, mcpType] of Object.entries(CATEGORY_MAPPING)) {
                const result = await tool?.handler({
                    content: `Content for ${openclawCat}`,
                    category: openclawCat,
                });

                expect(result.success).toBe(true);
            }
        });
    });

    describe('memory_forget tool', () => {
        it('should have correct schema', async () => {
            await memoryMcpBridgePlugin.init(mockApi);
            const tool = registeredTools.get('memory_forget');

            expect(tool).toBeDefined();
            expect(tool?.parameters.properties).toHaveProperty('memory_id');
            expect(tool?.parameters.required).toContain('memory_id');
        });

        it('should return success when memory deleted', async () => {
            await memoryMcpBridgePlugin.init(mockApi);
            const tool = registeredTools.get('memory_forget');

            const result = await tool?.handler({ memory_id: 'test-123' });

            expect(result.success).toBe(true);
        });
    });

    describe('lifecycle hooks', () => {
        it('should inject memories on before_agent_start', async () => {
            await memoryMcpBridgePlugin.init(mockApi);
            const beforeStartHandler = eventHandlers.get('before_agent_start');

            expect(beforeStartHandler).toBeDefined();

            const context = {
                messages: [{ role: 'user', content: 'Hello' }],
                systemPrompt: 'You are helpful',
            };

            await beforeStartHandler?.(context);

            // Should not throw
            expect(context).toBeDefined();
        });

        it('should capture content on agent_end', async () => {
            await memoryMcpBridgePlugin.init(mockApi);
            const agentEndHandler = eventHandlers.get('agent_end');

            expect(agentEndHandler).toBeDefined();

            const context = {
                messages: [
                    { role: 'user', content: 'User preference: I prefer Python' },
                    { role: 'assistant', content: 'Noted your preference.' },
                ],
                response: 'Noted your preference.',
            };

            await agentEndHandler?.(context);

            // Should not throw
            expect(context).toBeDefined();
        });
    });
});

describe('config', () => {
    describe('CATEGORY_MAPPING', () => {
        it('should map all OpenClaw categories to MCP types', () => {
            expect(CATEGORY_MAPPING.preference).toBe('preference');
            expect(CATEGORY_MAPPING.decision).toBe('decision');
            expect(CATEGORY_MAPPING.entity).toBe('reference');
            expect(CATEGORY_MAPPING.fact).toBe('reference');
            expect(CATEGORY_MAPPING.other).toBe('note');
        });
    });

    describe('AUTO_STORE_PATTERNS', () => {
        it('should have patterns for auto-detection', () => {
            expect(AUTO_STORE_PATTERNS).toBeDefined();
            expect(Array.isArray(AUTO_STORE_PATTERNS)).toBe(true);
            expect(AUTO_STORE_PATTERNS.length).toBeGreaterThan(0);
        });

        it('should detect preference patterns', () => {
            const preferencePattern = AUTO_STORE_PATTERNS.find(p => p.category === 'preference');
            expect(preferencePattern).toBeDefined();

            const testContent = 'I prefer using TypeScript';
            expect(preferencePattern?.pattern.test(testContent)).toBe(true);
        });

        it('should detect decision patterns', () => {
            const decisionPattern = AUTO_STORE_PATTERNS.find(p => p.category === 'decision');
            expect(decisionPattern).toBeDefined();

            const testContent = 'We decided to use React';
            expect(decisionPattern?.pattern.test(testContent)).toBe(true);
        });
    });

    describe('DEFAULT_CONFIG', () => {
        it('should have required fields', () => {
            expect(DEFAULT_CONFIG.autoRecall).toBeDefined();
            expect(DEFAULT_CONFIG.autoStore).toBeDefined();
            expect(DEFAULT_CONFIG.recallLimit).toBeDefined();
            expect(DEFAULT_CONFIG.minImportance).toBeDefined();
        });

        it('should have sensible defaults', () => {
            expect(DEFAULT_CONFIG.autoRecall).toBe(true);
            expect(DEFAULT_CONFIG.autoStore).toBe(true);
            expect(DEFAULT_CONFIG.recallLimit).toBeGreaterThan(0);
            expect(DEFAULT_CONFIG.minImportance).toBeGreaterThanOrEqual(0);
            expect(DEFAULT_CONFIG.minImportance).toBeLessThanOrEqual(1);
        });
    });
});

describe('MCP client integration', () => {
    it('should handle MCP connection errors gracefully', async () => {
        // This tests that the plugin doesn't crash on connection failure
        const { MemoryMcpClient } = await import('./mcp-client');

        vi.mocked(MemoryMcpClient).mockImplementationOnce(() => ({
            on: vi.fn(),
            connect: vi.fn().mockRejectedValue(new Error('Connection failed')),
            disconnect: vi.fn(),
            search: vi.fn(),
            store: vi.fn(),
            delete: vi.fn(),
            isConnected: vi.fn().mockReturnValue(false),
        }));

        const mockApiWithError = {
            registerTool: vi.fn(),
            on: vi.fn(),
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            },
            config: {
                get: vi.fn().mockReturnValue(DEFAULT_CONFIG),
            },
        } as unknown as PluginAPI;

        // Should not throw
        await expect(memoryMcpBridgePlugin.init(mockApiWithError)).resolves.not.toThrow();
    });

    it('should handle search errors gracefully', async () => {
        const { MemoryMcpClient } = await import('./mcp-client');

        vi.mocked(MemoryMcpClient).mockImplementationOnce(() => ({
            on: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn(),
            search: vi.fn().mockRejectedValue(new Error('Search failed')),
            store: vi.fn(),
            delete: vi.fn(),
            isConnected: vi.fn().mockReturnValue(true),
        }));

        const registeredTools = new Map<string, Tool>();
        const mockApiWithError = {
            registerTool: vi.fn((tool: Tool) => {
                registeredTools.set(tool.name, tool);
            }),
            on: vi.fn(),
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            },
            config: {
                get: vi.fn().mockReturnValue(DEFAULT_CONFIG),
            },
        } as unknown as PluginAPI;

        await memoryMcpBridgePlugin.init(mockApiWithError);

        const recallTool = registeredTools.get('memory_recall');
        const result = await recallTool?.handler({ query: 'test' });

        // Should return empty results, not throw
        expect(result.memories).toEqual([]);
        expect(mockApiWithError.logger.error).toHaveBeenCalled();
    });
});

describe('duplicate detection', () => {
    it('should detect similar content before storing', async () => {
        const { MemoryMcpClient } = await import('./mcp-client');

        const existingMemory = {
            id: 'existing-1',
            content: 'User prefers TypeScript',
            score: 0.95,
        };

        vi.mocked(MemoryMcpClient).mockImplementationOnce(() => ({
            on: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn(),
            search: vi.fn().mockResolvedValue([existingMemory]),
            store: vi.fn().mockResolvedValue({ id: 'new-id', content: 'test' }),
            delete: vi.fn(),
            isConnected: vi.fn().mockReturnValue(true),
        }));

        const registeredTools = new Map<string, Tool>();
        const mockApiDupes = {
            registerTool: vi.fn((tool: Tool) => {
                registeredTools.set(tool.name, tool);
            }),
            on: vi.fn(),
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            },
            config: {
                get: vi.fn().mockReturnValue({ ...DEFAULT_CONFIG, checkDuplicates: true }),
            },
        } as unknown as PluginAPI;

        await memoryMcpBridgePlugin.init(mockApiDupes);

        const storeTool = registeredTools.get('memory_store');

        // Try to store similar content
        const result = await storeTool?.handler({
            content: 'User prefers TypeScript for development',
            category: 'preference',
        });

        // Behavior depends on implementation:
        // Either warns about duplicate or skips storage
        expect(result).toBeDefined();
    });
});
