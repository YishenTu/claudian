/**
 * Agent load order (earlier sources take precedence for duplicate IDs):
 * 0. Built-in agents: dynamically provided via SDK init message
 * 1. Plugin agents: {installPath}/agents/*.md (namespaced as plugin-name:agent-name)
 * 2. Vault agents: {vaultPath}/.claude/agents/*.md
 * 3. Global agents: ~/.claude/agents/*.md
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentDefinition, AgentFrontmatter } from '../../../core/types';
import type { PluginManager } from '../plugins/PluginManager';
import { buildAgentFromFrontmatter, parseAgentFile } from './AgentStorage';

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

function normalizePluginName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
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

    for (const name of this.builtinAgentNames) {
      this.addAgent(makeBuiltinAgent(name));
    }

    try { this.loadPluginAgents(); } catch { /* non-critical */ }
    try { this.loadVaultAgents(); } catch { /* non-critical */ }
    try { this.loadGlobalAgents(); } catch { /* non-critical */ }
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

  private loadPluginAgents(): void {
    for (const plugin of this.pluginManager.getPlugins()) {
      if (!plugin.enabled) continue;

      const agentsDir = path.join(plugin.installPath, PLUGIN_AGENTS_DIR);
      if (!fs.existsSync(agentsDir)) continue;

      this.loadAgentsFromFiles(
        this.listMarkdownFiles(agentsDir),
        (filePath) => this.parsePluginAgentFromFile(filePath, plugin.name),
      );
    }
  }

  private loadVaultAgents(): void {
    this.loadAgentsFromDirectory(path.join(this.vaultPath, VAULT_AGENTS_DIR), 'vault');
  }

  private loadGlobalAgents(): void {
    this.loadAgentsFromDirectory(GLOBAL_AGENTS_DIR, 'global');
  }

  private loadAgentsFromDirectory(
    dir: string,
    source: 'vault' | 'global'
  ): void {
    if (!fs.existsSync(dir)) return;

    this.loadAgentsFromFiles(
      this.listMarkdownFiles(dir),
      (filePath) => this.parseAgentFromFile(filePath, source),
    );
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
      // Non-critical: directory may be unreadable
    }

    return files;
  }

  private parsePluginAgentFromFile(
    filePath: string,
    pluginName: string
  ): AgentDefinition | null {
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

  private parseAgentFromFile(
    filePath: string,
    source: 'vault' | 'global'
  ): AgentDefinition | null {
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

  private loadAgentsFromFiles(
    filePaths: string[],
    loadAgent: (filePath: string) => AgentDefinition | null,
  ): void {
    for (const filePath of filePaths) {
      this.addAgent(loadAgent(filePath));
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

  private parseAgentDefinition(
    filePath: string,
    buildId: (agentName: string) => string,
    buildAgent: (
      frontmatter: AgentFrontmatter,
      body: string,
      id: string,
    ) => AgentDefinition,
  ): AgentDefinition | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
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
