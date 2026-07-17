/**
 * Agent load order (earlier sources take precedence for duplicate IDs):
 * 0. Built-in agents: dynamically provided via SDK init message
 * 1. Plugin agents: {installPath}/agents/*.md (namespaced as plugin-name:agent-name)
 * 2. Vault agents: {vaultPath}/.claude/agents/*.md
 * 3. Global agents: {CLAUDE_CONFIG_DIR}/agents/*.md
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import type { AgentDefinition, AgentFrontmatter } from '../../../core/types';
import { mapWithConcurrency } from '../../../utils/concurrency';
import { resolveClaudeConfigDir } from '../config/ClaudeConfigDir';
import type { PluginManager } from '../plugins/PluginManager';
import { buildAgentFromFrontmatter, parseAgentFile } from './AgentStorage';

const VAULT_AGENTS_DIR = '.claude/agents';
const PLUGIN_AGENTS_DIR = 'agents';
const AGENT_FILE_READ_CONCURRENCY = 8;

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

function normalizePluginName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

export class AgentManager {
  private agents: AgentDefinition[] = FALLBACK_BUILTIN_AGENT_NAMES.map(makeBuiltinAgent);
  private builtinAgentNames: string[] = FALLBACK_BUILTIN_AGENT_NAMES;
  private vaultPath: string;
  private pluginManager: PluginManager;
  private resolveConfigDir: () => string;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(
    vaultPath: string,
    pluginManager: PluginManager,
    configDir: string | (() => string) = () => resolveClaudeConfigDir(),
  ) {
    this.vaultPath = vaultPath;
    this.pluginManager = pluginManager;
    this.resolveConfigDir = typeof configDir === 'function' ? configDir : () => configDir;
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
    if (this.loadPromise) {
      return this.loadPromise;
    }
    const promise = this.loadAgentsInternal();
    this.loadPromise = promise;
    try {
      await promise;
    } finally {
      if (this.loadPromise === promise) {
        this.loadPromise = null;
      }
    }
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await this.pluginManager.loadPlugins?.();
    await this.loadAgents();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  private async loadAgentsInternal(): Promise<void> {
    this.agents = [];

    for (const name of this.builtinAgentNames) {
      this.addAgent(makeBuiltinAgent(name));
    }

    try { await this.loadPluginAgents(); } catch { /* non-critical */ }
    try { await this.loadVaultAgents(); } catch { /* non-critical */ }
    try { await this.loadGlobalAgents(); } catch { /* non-critical */ }
    this.loaded = true;
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
      if (!plugin.enabled) continue;

      const agentsDir = path.join(plugin.installPath, PLUGIN_AGENTS_DIR);
      await this.loadAgentsFromFiles(
        await this.listMarkdownFiles(agentsDir),
        (filePath) => this.parsePluginAgentFromFile(filePath, plugin.name),
      );
    }
  }

  private async loadVaultAgents(): Promise<void> {
    await this.loadAgentsFromDirectory(path.join(this.vaultPath, VAULT_AGENTS_DIR), 'vault');
  }

  private async loadGlobalAgents(): Promise<void> {
    await this.loadAgentsFromDirectory(path.join(this.resolveConfigDir(), 'agents'), 'global');
  }

  private async loadAgentsFromDirectory(
    dir: string,
    source: 'vault' | 'global'
  ): Promise<void> {
    await this.loadAgentsFromFiles(
      await this.listMarkdownFiles(dir),
      (filePath) => this.parseAgentFromFile(filePath, source),
    );
  }

  private async listMarkdownFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => path.join(dir, entry.name));
    } catch {
      return [];
    }
  }

  private async parsePluginAgentFromFile(
    filePath: string,
    pluginName: string
  ): Promise<AgentDefinition | null> {
    return this.parseAgentDefinition(
      filePath,
      (agentName) => `${normalizePluginName(pluginName)}:${agentName}`,
      (frontmatter, body, id) => buildAgentFromFrontmatter(frontmatter, body, {
        id,
        source: 'plugin',
        pluginName,
        filePath,
      }),
    );
  }

  private async parseAgentFromFile(
    filePath: string,
    source: 'vault' | 'global'
  ): Promise<AgentDefinition | null> {
    return this.parseAgentDefinition(
      filePath,
      (agentName) => agentName,
      (frontmatter, body, id) => buildAgentFromFrontmatter(frontmatter, body, {
        id,
        source,
        filePath,
      }),
    );
  }

  private async loadAgentsFromFiles(
    filePaths: string[],
    loadAgent: (filePath: string) => Promise<AgentDefinition | null>,
  ): Promise<void> {
    const agents = await mapWithConcurrency(
      filePaths,
      filePath => loadAgent(filePath),
      AGENT_FILE_READ_CONCURRENCY,
    );
    for (const agent of agents) {
      this.addAgent(agent);
    }
  }

  private addAgent(agent: AgentDefinition | null): void {
    if (!agent) {
      return;
    }
    if (this.agents.some(existing => existing.id === agent.id)) {
      return;
    }
    this.agents.push(agent);
  }

  private async parseAgentDefinition(
    filePath: string,
    buildId: (agentName: string) => string,
    buildAgent: (
      frontmatter: AgentFrontmatter,
      body: string,
      id: string,
    ) => AgentDefinition,
  ): Promise<AgentDefinition | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = parseAgentFile(content);

      if (!parsed) {
        return null;
      }

      const { frontmatter, body } = parsed;
      return buildAgent(frontmatter, body, buildId(frontmatter.name));
    } catch {
      return null;
    }
  }
}
