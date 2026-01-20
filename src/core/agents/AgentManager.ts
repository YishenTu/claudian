/**
 * AgentManager - Discover and manage custom agent definitions.
 *
 * Loads agents from three sources (in priority order):
 * 1. Plugin agents: {pluginPath}/agents/*.md
 * 2. Vault agents: {vaultPath}/.claude/agents/*.md
 * 3. Global agents: ~/.claude/agents/*.md
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PluginManager } from '../plugins';
import type { AgentDefinition } from '../types';
import { parseAgentFile, parseModel, parseToolsList } from './AgentStorage';

/** Global agents directory. */
const GLOBAL_AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');

/** Vault agents directory (relative to vault root). */
const VAULT_AGENTS_DIR = '.claude/agents';

/** Plugin agents directory name. */
const PLUGIN_AGENTS_DIR = 'agents';

/** Built-in agents provided by the SDK */
const BUILTIN_AGENTS: Omit<AgentDefinition, 'filePath'>[] = [
  {
    id: 'Explore',
    name: 'Explore',
    description: 'Fast codebase exploration and search',
    prompt: '', // Built-in - prompt managed by SDK
    source: 'builtin',
  },
  {
    id: 'Plan',
    name: 'Plan',
    description: 'Implementation planning and architecture',
    prompt: '',
    source: 'builtin',
  },
  {
    id: 'Bash',
    name: 'Bash',
    description: 'Command execution specialist',
    prompt: '',
    source: 'builtin',
  },
  {
    id: 'general-purpose',
    name: 'General Purpose',
    description: 'Multi-step tasks and complex workflows',
    prompt: '',
    source: 'builtin',
  },
];

export class AgentManager {
  private agents: AgentDefinition[] = [];
  private vaultPath: string;
  private pluginManager: PluginManager;

  constructor(vaultPath: string, pluginManager: PluginManager) {
    this.vaultPath = vaultPath;
    this.pluginManager = pluginManager;
  }

  /**
   * Load all agent definitions from all sources.
   * Call this on plugin load and when agents may have changed.
   */
  async loadAgents(): Promise<void> {
    this.agents = [];

    // 0. Add built-in agents first
    for (const agent of BUILTIN_AGENTS) {
      this.agents.push(agent as AgentDefinition);
    }

    // 1. Load plugin agents (namespaced)
    await this.loadPluginAgents();

    // 2. Load vault agents
    await this.loadVaultAgents();

    // 3. Load global agents
    await this.loadGlobalAgents();
  }

  /**
   * Get all available agents, sorted by source priority.
   */
  getAvailableAgents(): AgentDefinition[] {
    return [...this.agents];
  }

  /**
   * Get agent by ID (exact match).
   */
  getAgentById(id: string): AgentDefinition | undefined {
    return this.agents.find(a => a.id === id);
  }

  /**
   * Get agents filtered by source.
   */
  getAgentsBySource(source: 'plugin' | 'vault' | 'global' | 'builtin'): AgentDefinition[] {
    return this.agents.filter(a => a.source === source);
  }

  /**
   * Search agents by name/description (for @ mention filtering).
   */
  searchAgents(query: string): AgentDefinition[] {
    const q = query.toLowerCase();
    return this.agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q)
    );
  }

  /**
   * Get all agent IDs for validation.
   */
  getAllAgentIds(): string[] {
    return this.agents.map(a => a.id);
  }

  /**
   * Load agents from enabled plugins.
   */
  private async loadPluginAgents(): Promise<void> {
    const plugins = this.pluginManager.getPlugins();

    for (const plugin of plugins) {
      if (!plugin.enabled || plugin.status !== 'available') {
        continue;
      }

      const agentsDir = path.join(plugin.installPath, PLUGIN_AGENTS_DIR);
      if (!fs.existsSync(agentsDir)) {
        continue;
      }

      const files = this.listMarkdownFiles(agentsDir);
      for (const filePath of files) {
        const agent = await this.parseAgentFromFile(filePath, 'plugin', plugin.name);
        if (agent) {
          this.agents.push(agent);
        }
      }
    }
  }

  /**
   * Load agents from vault .claude/agents directory.
   */
  private async loadVaultAgents(): Promise<void> {
    const agentsDir = path.join(this.vaultPath, VAULT_AGENTS_DIR);
    if (!fs.existsSync(agentsDir)) {
      return;
    }

    const files = this.listMarkdownFiles(agentsDir);
    for (const filePath of files) {
      const agent = await this.parseAgentFromFile(filePath, 'vault');
      if (agent) {
        this.agents.push(agent);
      }
    }
  }

  /**
   * Load agents from global ~/.claude/agents directory.
   */
  private async loadGlobalAgents(): Promise<void> {
    if (!fs.existsSync(GLOBAL_AGENTS_DIR)) {
      return;
    }

    const files = this.listMarkdownFiles(GLOBAL_AGENTS_DIR);
    for (const filePath of files) {
      const agent = await this.parseAgentFromFile(filePath, 'global');
      if (agent) {
        this.agents.push(agent);
      }
    }
  }

  /**
   * List all .md files in a directory (non-recursive).
   */
  private listMarkdownFiles(dir: string): string[] {
    const files: string[] = [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Return empty array if directory listing fails
    }

    return files;
  }

  /**
   * Parse an agent definition from a markdown file.
   */
  private async parseAgentFromFile(
    filePath: string,
    source: 'plugin' | 'vault' | 'global',
    pluginName?: string
  ): Promise<AgentDefinition | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseAgentFile(content);

      if (!parsed) {
        return null;
      }

      const { frontmatter, body } = parsed;

      // Build agent ID
      let id: string;
      if (source === 'plugin' && pluginName) {
        // Namespace plugin agents with plugin name
        const normalizedPluginName = pluginName.toLowerCase().replace(/\s+/g, '-');
        id = `${normalizedPluginName}:${frontmatter.name}`;
      } else {
        id = frontmatter.name;
      }

      // Check for duplicate ID
      if (this.agents.find(a => a.id === id)) {
        return null;
      }

      return {
        id,
        name: frontmatter.name,
        description: frontmatter.description,
        prompt: body,
        tools: parseToolsList(frontmatter.tools),
        disallowedTools: parseToolsList(frontmatter.disallowedTools),
        model: parseModel(frontmatter.model),
        source,
        pluginName: source === 'plugin' ? pluginName : undefined,
        filePath,
      };
    } catch {
      return null;
    }
  }
}
