import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import {
  createKimiWorkspaceServices,
  type KimiWorkspaceServices,
} from '@/providers/kimi/app/KimiWorkspaceServices';

function createMockPlugin(): ProviderHost {
  return {
    app: { vault: { adapter: { basePath: '/tmp/kimi-workspace-vault' } } },
    settings: { providerConfigs: { kimi: { enabled: true } } },
  } as unknown as ProviderHost;
}

function createMockVaultAdapter(files: Record<string, string> = {}): VaultFileAdapter {
  return {
    exists: jest.fn(async (targetPath: string) =>
      targetPath in files || Object.keys(files).some((key) => key.startsWith(`${targetPath}/`)),
    ),
    read: jest.fn(async (targetPath: string) => {
      if (!(targetPath in files)) {
        throw new Error(`File not found: ${targetPath}`);
      }
      return files[targetPath];
    }),
    write: jest.fn(async (targetPath: string, content: string) => {
      files[targetPath] = content;
    }),
    listFilesRecursive: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : `${folder}/`;
      return Object.keys(files).filter((key) => key.startsWith(prefix));
    }),
  } as unknown as VaultFileAdapter;
}

const AGENT_MARKDOWN = `---
name: code-reviewer
description: "Reviews code for correctness."
---
Review code like an owner.
`;

const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    'local-tools': { command: 'node', args: ['server.js'] },
  },
});

describe('createKimiWorkspaceServices', () => {
  let services: KimiWorkspaceServices;

  beforeEach(async () => {
    services = await createKimiWorkspaceServices(
      createMockPlugin(),
      createMockVaultAdapter({
        '.kimi-code/agents/code-reviewer.md': AGENT_MARKDOWN,
        '.kimi-code/mcp.json': MCP_CONFIG,
      }),
    );
  });

  it('exposes an agent mention provider backed by vault agent files', async () => {
    expect(services.agentMentionProvider).toBeDefined();
    expect(services.refreshAgentMentions).toBeDefined();

    await services.refreshAgentMentions?.();

    expect(services.agentMentionProvider?.searchAgents('review')).toEqual([
      {
        description: 'Reviews code for correctness.',
        id: 'code-reviewer',
        name: 'code-reviewer',
        source: 'vault',
      },
    ]);
  });

  it('exposes an MCP server manager backed by the vault mcp.json', async () => {
    expect(services.mcpServerManager).toBeDefined();
    expect(services.mcpStorage).toBeDefined();

    await services.mcpServerManager?.ensureLoaded();

    expect(services.mcpServerManager?.getServers()).toEqual([
      {
        name: 'local-tools',
        config: { command: 'node', args: ['server.js'] },
        enabled: true,
        contextSaving: true,
        disabledTools: undefined,
        description: undefined,
      },
    ]);
  });

  it('preloads agents and MCP servers for the settings tab', async () => {
    await services.prepareSettings?.();

    expect(services.agentMentionProvider?.isLoaded?.()).toBe(true);
    expect(services.mcpServerManager?.isLoaded()).toBe(true);
  });
});
