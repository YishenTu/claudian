/**
 * Agent load order (earlier sources take precedence for duplicate IDs):
 * 0. Built-in agents: dynamically provided via SDK init message
 * 1. Plugin agents: {pluginPath}/agents/*.md (namespaced as plugin-name:agent-name)
 * 2. Vault agents: {vaultPath}/.claude/agents/*.md
 * 3. Global agents: ~/.claude/agents/*.md
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PluginManager } from '../plugins';
import type { AgentDefinition } from '../types';
import { parseAgentFile, parseModel, parseToolsList } from './AgentStorage';

const GLOBAL_AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');
const VAULT_AGENTS_DIR = '.claude/agents';
const PLUGIN_AGENTS_DIR = 'agents';

// Fallback built-in agent names for before the init message arrives.
const FALLBACK_BUILTIN_AGENT_NAMES = ['Explore', 'Plan', 'Bash', 'general-purpose'];

const BUILTIN_AGENT_DESCRIPTIONS: Record<string, string> = {
  'Explore': 'Fast codebase exploration and search',
  'Plan': 'Implementation planning and architecture',
  'Bash': 'Command execution specialist',
  'general-purpose': 'Multi-step tasks and complex workflows',
};

function makeBuiltinAgent(name: string): AgentDefinition {
  return {
    id: name,
    name: name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    description: BUILTIN_AGENT_DESCRIPTIONS[name] ?? '',
    prompt: '', // Built-in — prompt managed by SDK
    source: 'builtin',
  };
}

export class AgentManager {
  private agents: AgentDefinition[] = [];
  private builtinAgentNames: string[] = FALLBACK_BUILTIN_AGENT_NAMES;
  private vaultPath: string;
  private pluginManager: PluginManager;

  constructor(vaultPath: string, pluginManager: PluginManager) {
    this.vaultPath = vaultPath;
    this.pluginManager = pluginManager;
  }

  /** Built-in agents are those from init that are NOT loaded from files. */
  setBuiltinAgentNames(names: string[]): void {
    this.builtinAgentNames = names;
    // Rebuild agents to reflect the new built-in list
    const fileAgentIds = new Set(
      this.agents.filter(a => a.source !== 'builtin').map(a => a.id)
    );
    // Replace built-in entries with updated list
    this.agents = [
      ...names.filter(n => !fileAgentIds.has(n)).map(makeBuiltinAgent),
      ...this.agents.filter(a => a.source !== 'builtin'),
    ];
  }

  async loadAgents(): Promise<void> {
    this.agents = [];

    // 0. Add built-in agents first (from init message or fallback)
    this.agents.push(...this.builtinAgentNames.map(makeBuiltinAgent));

    // 1. Load plugin agents (namespaced)
    await this.loadPluginAgents();

    // 2. Load vault agents
    await this.loadVaultAgents();

    // 3. Load global agents
    await this.loadGlobalAgents();
  }

  getAvailableAgents(): AgentDefinition[] {
    return [...this.agents];
  }

  getAgentById(id: string): AgentDefinition | undefined {
    return this.agents.find(a => a.id === id);
  }

  /** Used for @-mention filtering in the chat input. */
  searchAgents(query: string): AgentDefinition[] {
    const q = query.toLowerCase();
    return this.agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q)
    );
  }

  private async loadPluginAgents(): Promise<void> {
    for (const plugin of this.pluginManager.getPlugins()) {
      if (!plugin.enabled || plugin.status !== 'available') continue;
      await this.loadAgentsFromDirectory(
        path.join(plugin.installPath, PLUGIN_AGENTS_DIR),
        'plugin',
        plugin.name
      );
    }
  }

  private async loadVaultAgents(): Promise<void> {
    await this.loadAgentsFromDirectory(path.join(this.vaultPath, VAULT_AGENTS_DIR), 'vault');
  }

  private async loadGlobalAgents(): Promise<void> {
    await this.loadAgentsFromDirectory(GLOBAL_AGENTS_DIR, 'global');
  }

  private async loadAgentsFromDirectory(
    dir: string,
    source: 'plugin' | 'vault' | 'global',
    pluginName?: string
  ): Promise<void> {
    if (!fs.existsSync(dir)) return;

    for (const filePath of this.listMarkdownFiles(dir)) {
      const agent = await this.parseAgentFromFile(filePath, source, pluginName);
      if (agent) this.agents.push(agent);
    }
  }

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
      // Non-critical: directory listing failed, skip silently
    }

    return files;
  }

  private async parseAgentFromFile(
    filePath: string,
    source: 'plugin' | 'vault' | 'global',
    pluginName?: string
  ): Promise<AgentDefinition | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseAgentFile(content);

      if (!parsed) return null;

      const { frontmatter, body } = parsed;

      let id: string;
      if (source === 'plugin' && pluginName) {
        const normalizedPluginName = pluginName.toLowerCase().replace(/\s+/g, '-');
        id = `${normalizedPluginName}:${frontmatter.name}`;
      } else {
        id = frontmatter.name;
      }

      // Skip duplicate IDs (earlier sources take precedence)
      if (this.agents.find(a => a.id === id)) return null;

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
        skills: frontmatter.skills,
        maxTurns: frontmatter.maxTurns,
        mcpServers: frontmatter.mcpServers,
      };
    } catch {
      // Non-critical: agent file failed to load, skip silently
      return null;
    }
  }
}
