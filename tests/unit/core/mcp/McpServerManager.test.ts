import { McpServerManager } from '@/core/mcp';
import type { ClaudianMcpServer } from '@/core/types';

describe('McpServerManager.getDisallowedMcpTools', () => {
  const createManager = async (servers: ClaudianMcpServer[]) => {
    const manager = new McpServerManager({
      load: async () => servers,
    });
    await manager.loadServers();
    return manager;
  };

  it('returns empty array when no servers are loaded', async () => {
    const manager = await createManager([]);
    expect(manager.getDisallowedMcpTools(new Set())).toEqual([]);
  });

  it('formats disabled tools for enabled servers', async () => {
    const manager = await createManager([
      {
        name: 'alpha',
        config: { command: 'alpha-cmd' },
        enabled: true,
        contextSaving: false,
        disabledTools: ['tool_a', 'tool_b'],
      },
    ]);

    expect(manager.getDisallowedMcpTools(new Set())).toEqual([
      'mcp__alpha__tool_a',
      'mcp__alpha__tool_b',
    ]);
  });

  it('skips disabled servers', async () => {
    const manager = await createManager([
      {
        name: 'alpha',
        config: { command: 'alpha-cmd' },
        enabled: false,
        contextSaving: false,
        disabledTools: ['tool_a'],
      },
      {
        name: 'beta',
        config: { command: 'beta-cmd' },
        enabled: true,
        contextSaving: false,
        disabledTools: ['tool_b'],
      },
    ]);

    expect(manager.getDisallowedMcpTools(new Set())).toEqual(['mcp__beta__tool_b']);
  });

  it('trims tool names and ignores blanks', async () => {
    const manager = await createManager([
      {
        name: 'alpha',
        config: { command: 'alpha-cmd' },
        enabled: true,
        contextSaving: false,
        disabledTools: ['  tool_a  ', ''],
      },
    ]);

    expect(manager.getDisallowedMcpTools(new Set())).toEqual(['mcp__alpha__tool_a']);
  });

  it('skips context-saving servers not mentioned', async () => {
    const manager = await createManager([
      {
        name: 'alpha',
        config: { command: 'alpha-cmd' },
        enabled: true,
        contextSaving: true,
        disabledTools: ['tool_a'],
      },
      {
        name: 'beta',
        config: { command: 'beta-cmd' },
        enabled: true,
        contextSaving: false,
        disabledTools: ['tool_b'],
      },
    ]);

    // alpha is context-saving but not mentioned, so its disabled tools are not included
    expect(manager.getDisallowedMcpTools(new Set())).toEqual(['mcp__beta__tool_b']);
  });

  it('includes context-saving servers when mentioned', async () => {
    const manager = await createManager([
      {
        name: 'alpha',
        config: { command: 'alpha-cmd' },
        enabled: true,
        contextSaving: true,
        disabledTools: ['tool_a'],
      },
      {
        name: 'beta',
        config: { command: 'beta-cmd' },
        enabled: true,
        contextSaving: false,
        disabledTools: ['tool_b'],
      },
    ]);

    // alpha is mentioned, so its disabled tools are included
    expect(manager.getDisallowedMcpTools(new Set(['alpha']))).toEqual([
      'mcp__alpha__tool_a',
      'mcp__beta__tool_b',
    ]);
  });
});
