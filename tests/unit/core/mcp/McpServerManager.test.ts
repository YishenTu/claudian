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
    expect(manager.getDisallowedMcpTools()).toEqual([]);
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

    expect(manager.getDisallowedMcpTools()).toEqual([
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

    expect(manager.getDisallowedMcpTools()).toEqual(['mcp__beta__tool_b']);
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

    expect(manager.getDisallowedMcpTools()).toEqual(['mcp__alpha__tool_a']);
  });
});
