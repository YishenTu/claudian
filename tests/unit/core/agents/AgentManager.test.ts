import * as fs from 'fs';
import * as path from 'path';

// Mock fs and os modules BEFORE importing AgentManager
jest.mock('fs');
jest.mock('os', () => ({
  homedir: jest.fn().mockReturnValue('/home/user'),
}));

import { AgentManager } from '@/core/agents/AgentManager';
import type { PluginManager } from '@/core/plugins/PluginManager';

const mockFs = jest.mocked(fs);

// Create a mock PluginManager
function createMockPluginManager(plugins: Array<{ name: string; enabled: boolean; installPath: string }> = []): PluginManager {
  return {
    getPlugins: jest.fn().mockReturnValue(plugins.map(p => ({
      id: `${p.name}@test`,
      name: p.name,
      enabled: p.enabled,
      scope: 'user' as const,
      installPath: p.installPath,
    }))),
  } as unknown as PluginManager;
}

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

const PLUGIN_AGENT_FILE = `---
name: code-reviewer
description: Reviews code for issues
tools: [Read, Grep]
model: sonnet
---
You review code.`;

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
    it('creates an AgentManager with vault path', () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      expect(manager).toBeInstanceOf(AgentManager);
    });
  });

  describe('loadAgents', () => {
    it('includes built-in agents by default', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      expect(agents.length).toBeGreaterThanOrEqual(4);
      expect(agents.find(a => a.id === 'Explore')).toBeDefined();
      expect(agents.find(a => a.id === 'Plan')).toBeDefined();
      expect(agents.find(a => a.id === 'Bash')).toBeDefined();
      expect(agents.find(a => a.id === 'general-purpose')).toBeDefined();
    });

    it('built-in agents have correct properties', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      await manager.loadAgents();
      const explore = manager.getAgentById('Explore');

      expect(explore).toBeDefined();
      expect(explore?.source).toBe('builtin');
      expect(explore?.name).toBe('Explore');
      expect(explore?.description).toBe('Fast codebase exploration and search');
    });

    it('loads agents from vault directory', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

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
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

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

    it('skips invalid agent files', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

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

    it('isolates errors per category so one failure does not block others', async () => {
      const pluginManager = createMockPluginManager([
        { name: 'Broken', enabled: true, installPath: '/plugins/broken' },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      // Plugin agents dir exists but getPlugins throws internally on iteration
      // Vault agents load normally, global dir doesn't exist
      mockFs.existsSync.mockImplementation((p) =>
        p === path.join('/plugins/broken', 'agents') || p === VAULT_AGENTS_DIR
      );
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === path.join('/plugins/broken', 'agents')) {
          throw new Error('Corrupt plugin directory');
        }
        if (dir === VAULT_AGENTS_DIR) {
          return [createMockDirent('vault-agent.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(MINIMAL_AGENT_FILE);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      // Vault agent should still be loaded despite plugin error
      expect(agents.some(a => a.source === 'vault')).toBe(true);
    });

    it('skips duplicate agent IDs', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

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
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

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
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

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
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

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
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

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

    it('loads plugin agents with namespaced IDs', async () => {
      const pluginManager = createMockPluginManager([
        { name: 'PR Review Toolkit', enabled: true, installPath: '/plugins/pr-review' },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);
      const pluginAgentsDir = path.join('/plugins/pr-review', 'agents');

      mockFs.existsSync.mockImplementation((p) => p === pluginAgentsDir);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === pluginAgentsDir) {
          return [createMockDirent('reviewer.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(PLUGIN_AGENT_FILE);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      const pluginAgent = agents.find(a => a.source === 'plugin');
      expect(pluginAgent).toBeDefined();
      expect(pluginAgent?.id).toBe('pr-review-toolkit:code-reviewer');
      expect(pluginAgent?.name).toBe('code-reviewer');
      expect(pluginAgent?.description).toBe('Reviews code for issues');
      expect(pluginAgent?.tools).toEqual(['Read', 'Grep']);
      expect(pluginAgent?.model).toBe('sonnet');
      expect(pluginAgent?.pluginName).toBe('PR Review Toolkit');
    });

    it('skips disabled plugins', async () => {
      const pluginManager = createMockPluginManager([
        { name: 'Disabled Plugin', enabled: false, installPath: '/plugins/disabled' },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      expect(agents.every(a => a.source !== 'plugin')).toBe(true);
    });

    it('skips plugins without agents directory', async () => {
      const pluginManager = createMockPluginManager([
        { name: 'No Agents', enabled: true, installPath: '/plugins/no-agents' },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      mockFs.existsSync.mockReturnValue(false);

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      expect(agents.every(a => a.source !== 'plugin')).toBe(true);
    });

    it('normalizes plugin name to lowercase with hyphens in agent ID', async () => {
      const pluginManager = createMockPluginManager([
        { name: 'My  Cool  Plugin', enabled: true, installPath: '/plugins/cool' },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);
      const pluginAgentsDir = path.join('/plugins/cool', 'agents');

      mockFs.existsSync.mockImplementation((p) => p === pluginAgentsDir);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === pluginAgentsDir) {
          return [createMockDirent('agent.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(PLUGIN_AGENT_FILE);

      await manager.loadAgents();
      const pluginAgent = manager.getAvailableAgents().find(a => a.source === 'plugin');

      expect(pluginAgent?.id).toBe('my-cool-plugin:code-reviewer');
    });

    it('skips duplicate plugin agent IDs', async () => {
      const pluginManager = createMockPluginManager([
        { name: 'Plugin A', enabled: true, installPath: '/plugins/a' },
        { name: 'Plugin A', enabled: true, installPath: '/plugins/a-copy' },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);

      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue([createMockDirent('agent.md', true)]);
      mockFs.readFileSync.mockReturnValue(PLUGIN_AGENT_FILE);

      await manager.loadAgents();
      const pluginAgents = manager.getAvailableAgents().filter(a => a.source === 'plugin');

      expect(pluginAgents.length).toBe(1);
    });

    it('handles malformed plugin agent files gracefully', async () => {
      const pluginManager = createMockPluginManager([
        { name: 'Bad Plugin', enabled: true, installPath: '/plugins/bad' },
      ]);
      const manager = new AgentManager(VAULT_PATH, pluginManager);
      const pluginAgentsDir = path.join('/plugins/bad', 'agents');

      mockFs.existsSync.mockImplementation((p) => p === pluginAgentsDir);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir === pluginAgentsDir) {
          return [createMockDirent('broken.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      await manager.loadAgents();
      const agents = manager.getAvailableAgents();

      expect(agents.every(a => a.source !== 'plugin')).toBe(true);
    });
  });

  describe('getAvailableAgents', () => {
    it('returns a copy of the agents array', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      await manager.loadAgents();
      const agents1 = manager.getAvailableAgents();
      const agents2 = manager.getAvailableAgents();

      expect(agents1).not.toBe(agents2);
      expect(agents1).toEqual(agents2);
    });
  });

  describe('getAgentById', () => {
    it('returns agent by exact ID match', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      await manager.loadAgents();
      const agent = manager.getAgentById('Explore');

      expect(agent).toBeDefined();
      expect(agent?.id).toBe('Explore');
    });

    it('returns undefined for non-existent ID', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      await manager.loadAgents();
      const agent = manager.getAgentById('NonExistent');

      expect(agent).toBeUndefined();
    });
  });

  describe('searchAgents', () => {
    it('searches by name (case-insensitive)', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      await manager.loadAgents();
      const results = manager.searchAgents('explore');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe('Explore');
    });

    it('searches by ID', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      await manager.loadAgents();
      const results = manager.searchAgents('general-purpose');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.id === 'general-purpose')).toBe(true);
    });

    it('searches by description', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      await manager.loadAgents();
      const results = manager.searchAgents('codebase');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.id === 'Explore')).toBe(true);
    });

    it('returns empty array for no matches', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      await manager.loadAgents();
      const results = manager.searchAgents('xyznonexistent');

      expect(results).toEqual([]);
    });

    it('returns multiple matches', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      await manager.loadAgents();
      // 'a' should match multiple built-in agents
      const results = manager.searchAgents('a');

      expect(results.length).toBeGreaterThan(1);
    });
  });

  describe('agent with missing optional fields', () => {
    it('handles agents without tools specification', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

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

  describe('setBuiltinAgentNames', () => {
    it('updates built-in agents from init message names', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());
      mockFs.existsSync.mockReturnValue(false);

      await manager.loadAgents();
      const before = manager.getAvailableAgents();
      expect(before.some(a => a.id === 'Explore')).toBe(true);

      // Update with new names from init
      manager.setBuiltinAgentNames(['Explore', 'Plan', 'Bash', 'general-purpose', 'new-agent']);
      const after = manager.getAvailableAgents();
      expect(after.some(a => a.id === 'new-agent' && a.source === 'builtin')).toBe(true);
    });

    it('excludes file-loaded agents from built-in list', async () => {
      const manager = new AgentManager(VAULT_PATH, createMockPluginManager());

      // Vault has an agent file matching an init agent name
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        if (dir.includes('.claude/agents')) {
          return [createMockDirent('custom.md', true)];
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(`---
name: custom-agent
description: Custom vault agent
---
Prompt.`);

      await manager.loadAgents();

      // Set init names that include 'custom-agent' (matches vault agent)
      manager.setBuiltinAgentNames(['Explore', 'custom-agent']);
      const agents = manager.getAvailableAgents();

      // custom-agent should be vault-sourced, not built-in
      const customAgent = agents.find(a => a.id === 'custom-agent');
      expect(customAgent).toBeDefined();
      expect(customAgent?.source).toBe('vault');

      // Should not have a duplicate built-in 'custom-agent'
      const customAgents = agents.filter(a => a.id === 'custom-agent');
      expect(customAgents).toHaveLength(1);
    });
  });
});
