import * as fs from 'fs';
import * as path from 'path';

// Mock fs and os modules BEFORE importing AgentManager
jest.mock('fs');
jest.mock('os', () => ({
  homedir: jest.fn().mockReturnValue('/home/user'),
}));

import { AgentManager } from '@/core/agents/AgentManager';
import type { ClaudianPlugin } from '@/core/types';

const mockFs = jest.mocked(fs);

// Helper to create mock Dirent objects
function createMockDirent(name: string, isFile: boolean): fs.Dirent {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    path: '',
    parentPath: '',
  } as fs.Dirent;
}

// Create a mock PluginManager
function createMockPluginManager(plugins: Partial<ClaudianPlugin>[] = []) {
  return {
    getPlugins: jest.fn().mockReturnValue(
      plugins.map(p => ({
        id: p.id || 'test-plugin',
        name: p.name || 'Test Plugin',
        installPath: p.installPath || '/path/to/plugin',
        enabled: p.enabled ?? false,
        status: p.status || 'available',
        ...p,
      }))
    ),
  } as any;
}

// Sample agent file content
const VALID_AGENT_FILE = `---
name: TestAgent
description: A test agent for testing
tools: [Read, Grep]
disallowedTools: [Write]
model: sonnet
---
You are a helpful test agent.`;

const MINIMAL_AGENT_FILE = `---
name: MinimalAgent
description: Minimal agent
---
Simple prompt.`;

const INVALID_AGENT_FILE = `---
name: [InvalidName]
description: Valid description
---
Body.`;

describe('AgentManager', () => {
  const VAULT_PATH = '/test/vault';
  const HOME_DIR = '/home/user';
  const GLOBAL_AGENTS_DIR = path.join(HOME_DIR, '.claude', 'agents');
  const VAULT_AGENTS_DIR = path.join(VAULT_PATH, '.claude/agents');

  beforeEach(() => {
    jest.clearAllMocks();
    // os.homedir is already mocked to return HOME_DIR
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readdirSync.mockReturnValue([]);
  });

  describe('constructor', () => {
    it('creates an AgentManager with vault path and plugin manager', () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      expect(manager).toBeInstanceOf(AgentManager);
    });
  });

  describe('loadAgents', () => {
    it('includes built-in agents by default', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      expect(agents.length).toBeGreaterThanOrEqual(4);
      expect(agents.find(a => a.id === 'Explore')).toBeDefined();
      expect(agents.find(a => a.id === 'Plan')).toBeDefined();
      expect(agents.find(a => a.id === 'Bash')).toBeDefined();
      expect(agents.find(a => a.id === 'general-purpose')).toBeDefined();
    });

    it('built-in agents have correct properties', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const explore = manager.getAgentById('Explore');

      expect(explore).toBeDefined();
      expect(explore?.source).toBe('builtin');
      expect(explore?.name).toBe('Explore');
      expect(explore?.description).toBe('Fast codebase exploration and search');
    });

    it('loads agents from vault directory', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      mockFs.existsSync.mockImplementation((p) => p === VAULT_AGENTS_DIR);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === VAULT_AGENTS_DIR) {
          return [createMockDirent('test-agent.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(VALID_AGENT_FILE);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      const vaultAgent = agents.find(a => a.id === 'TestAgent' && a.source === 'vault');
      expect(vaultAgent).toBeDefined();
      expect(vaultAgent?.name).toBe('TestAgent');
      expect(vaultAgent?.description).toBe('A test agent for testing');
      expect(vaultAgent?.tools).toEqual(['Read', 'Grep']);
      expect(vaultAgent?.disallowedTools).toEqual(['Write']);
      expect(vaultAgent?.model).toBe('sonnet');
    });

    it('loads agents from global directory', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      mockFs.existsSync.mockImplementation((p) => p === GLOBAL_AGENTS_DIR);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === GLOBAL_AGENTS_DIR) {
          return [createMockDirent('global-agent.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(MINIMAL_AGENT_FILE);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      const globalAgent = agents.find(a => a.id === 'MinimalAgent' && a.source === 'global');
      expect(globalAgent).toBeDefined();
      expect(globalAgent?.source).toBe('global');
    });

    it('loads agents from enabled plugins with namespace', async () => {
      const pluginManager = createMockPluginManager([
        {
          id: 'my-plugin',
          name: 'My Plugin',
          installPath: '/plugins/my-plugin',
          enabled: true,
          status: 'available',
        },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);
      const pluginAgentsDir = path.join('/plugins/my-plugin', 'agents');

      mockFs.existsSync.mockImplementation((p) => p === pluginAgentsDir);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === pluginAgentsDir) {
          return [createMockDirent('plugin-agent.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(VALID_AGENT_FILE);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      // Plugin agents should be namespaced
      const pluginAgent = agents.find(a => a.id === 'my-plugin:TestAgent');
      expect(pluginAgent).toBeDefined();
      expect(pluginAgent?.source).toBe('plugin');
      expect(pluginAgent?.pluginName).toBe('My Plugin');
    });

    it('skips disabled plugins', async () => {
      const pluginManager = createMockPluginManager([
        {
          id: 'disabled-plugin',
          name: 'Disabled Plugin',
          installPath: '/plugins/disabled',
          enabled: false,
          status: 'available',
        },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      // Should only have built-in agents
      expect(agents.every(a => a.source === 'builtin')).toBe(true);
    });

    it('skips unavailable plugins', async () => {
      const pluginManager = createMockPluginManager([
        {
          id: 'unavailable-plugin',
          name: 'Unavailable Plugin',
          installPath: '/plugins/unavailable',
          enabled: true,
          status: 'unavailable',
        },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      // Should only have built-in agents
      expect(agents.every(a => a.source === 'builtin')).toBe(true);
    });

    it('skips invalid agent files', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      mockFs.existsSync.mockImplementation((p) => p === VAULT_AGENTS_DIR);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === VAULT_AGENTS_DIR) {
          return [createMockDirent('invalid-agent.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(INVALID_AGENT_FILE);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      // Should only have built-in agents (invalid agent skipped)
      expect(agents.every(a => a.source === 'builtin')).toBe(true);
    });

    it('skips duplicate agent IDs', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      // Both vault and global have same agent name
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockImplementation(() => {
        return [createMockDirent('duplicate.md', true)];
      });
      mockFs.readFileSync.mockReturnValue(MINIMAL_AGENT_FILE);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      // Should only have one MinimalAgent (vault takes priority over global)
      const minimalAgents = agents.filter(a => a.name === 'MinimalAgent');
      expect(minimalAgents.length).toBe(1);
      expect(minimalAgents[0].source).toBe('vault');
    });

    it('handles directory read errors gracefully', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      // Should still have built-in agents
      expect(agents.length).toBeGreaterThanOrEqual(4);
    });

    it('handles file read errors gracefully', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      mockFs.existsSync.mockImplementation((p) => p === VAULT_AGENTS_DIR);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === VAULT_AGENTS_DIR) {
          return [createMockDirent('error-agent.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('File read error');
      });

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      // Should only have built-in agents
      expect(agents.every(a => a.source === 'builtin')).toBe(true);
    });

    it('ignores non-markdown files', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      mockFs.existsSync.mockImplementation((p) => p === VAULT_AGENTS_DIR);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === VAULT_AGENTS_DIR) {
          return [
            createMockDirent('agent.txt', true),
            createMockDirent('agent.json', true),
            createMockDirent('valid-agent.md', true),
          ];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(MINIMAL_AGENT_FILE);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      // Only the .md file should be parsed
      const vaultAgents = agents.filter(a => a.source === 'vault');
      expect(vaultAgents.length).toBe(1);
    });

    it('ignores directories', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      mockFs.existsSync.mockImplementation((p) => p === VAULT_AGENTS_DIR);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === VAULT_AGENTS_DIR) {
          return [
            createMockDirent('subdir', false),
            createMockDirent('valid-agent.md', true),
          ];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(MINIMAL_AGENT_FILE);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      // Only files should be processed
      const vaultAgents = agents.filter(a => a.source === 'vault');
      expect(vaultAgents.length).toBe(1);
    });
  });

  describe('getAvailableAgents', () => {
    it('returns a copy of the agents array', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const agents1 = manager.getAvailableAgents();
      const agents2 = manager.getAvailableAgents();

      expect(agents1).not.toBe(agents2);
      expect(agents1).toEqual(agents2);
    });
  });

  describe('getAgentById', () => {
    it('returns agent by exact ID match', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const agent = manager.getAgentById('Explore');

      expect(agent).toBeDefined();
      expect(agent?.id).toBe('Explore');
    });

    it('returns undefined for non-existent ID', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const agent = manager.getAgentById('NonExistent');

      expect(agent).toBeUndefined();
    });

    it('matches namespaced plugin agent IDs', async () => {
      const pluginManager = createMockPluginManager([
        {
          id: 'my-plugin',
          name: 'My Plugin',
          installPath: '/plugins/my-plugin',
          enabled: true,
          status: 'available',
        },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);
      const pluginAgentsDir = path.join('/plugins/my-plugin', 'agents');

      mockFs.existsSync.mockImplementation((p) => p === pluginAgentsDir);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === pluginAgentsDir) {
          return [createMockDirent('plugin-agent.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(VALID_AGENT_FILE);

      await manager.loadAgents();
      const agent = manager.getAgentById('my-plugin:TestAgent');

      expect(agent).toBeDefined();
      expect(agent?.id).toBe('my-plugin:TestAgent');
    });
  });

  describe('searchAgents', () => {
    it('searches by name (case-insensitive)', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const results = manager.searchAgents('explore');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe('Explore');
    });

    it('searches by ID', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const results = manager.searchAgents('general-purpose');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.id === 'general-purpose')).toBe(true);
    });

    it('searches by description', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const results = manager.searchAgents('codebase');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.id === 'Explore')).toBe(true);
    });

    it('returns empty array for no matches', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const results = manager.searchAgents('xyznonexistent');

      expect(results).toEqual([]);
    });

    it('returns multiple matches', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      // 'a' should match multiple built-in agents
      const results = manager.searchAgents('a');

      expect(results.length).toBeGreaterThan(1);
    });
  });

  describe('plugin name normalization', () => {
    it('normalizes plugin names with spaces', async () => {
      const pluginManager = createMockPluginManager([
        {
          id: 'my-plugin',
          name: 'My Awesome Plugin',
          installPath: '/plugins/my-plugin',
          enabled: true,
          status: 'available',
        },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);
      const pluginAgentsDir = path.join('/plugins/my-plugin', 'agents');

      mockFs.existsSync.mockImplementation((p) => p === pluginAgentsDir);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === pluginAgentsDir) {
          return [createMockDirent('agent.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(VALID_AGENT_FILE);

      await manager.loadAgents();
      const agent = manager.getAgentById('my-awesome-plugin:TestAgent');

      expect(agent).toBeDefined();
      expect(agent?.id).toBe('my-awesome-plugin:TestAgent');
    });
  });

  describe('agent with missing optional fields', () => {
    it('handles agents without tools specification', async () => {
      const pluginManager = createMockPluginManager();
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      mockFs.existsSync.mockImplementation((p) => p === VAULT_AGENTS_DIR);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === VAULT_AGENTS_DIR) {
          return [createMockDirent('minimal.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(MINIMAL_AGENT_FILE);

      await manager.loadAgents();
      const agent = manager.getAgentById('MinimalAgent');

      expect(agent).toBeDefined();
      expect(agent?.tools).toBeUndefined();
      expect(agent?.disallowedTools).toBeUndefined();
      expect(agent?.model).toBe('inherit');
    });
  });
});
