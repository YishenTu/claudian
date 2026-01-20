/**
 * Agent definition types for custom subagent support.
 *
 * Custom agents are defined in markdown files with YAML frontmatter,
 * matching Claude Code's agent format for compatibility.
 */

/**
 * Agent definition loaded from markdown files with YAML frontmatter.
 * Matches Claude Code's agent format for compatibility.
 */
export interface AgentDefinition {
  /** Unique identifier. Namespaced for plugins: "plugin-name:agent-name" */
  id: string;

  /** Display name (from YAML `name` field) */
  name: string;

  /** Description of when to use this agent */
  description: string;

  /** System prompt for the agent (markdown body after frontmatter) */
  prompt: string;

  /** Allowed tools. If undefined, inherits all tools from parent */
  tools?: string[];

  /** Model override. 'inherit' (default) uses parent's model */
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';

  /** Source of the agent definition */
  source: 'plugin' | 'vault' | 'global';

  /** Plugin name (only for plugin-sourced agents) */
  pluginName?: string;

  /** Absolute path to the source .md file */
  filePath: string;
}

/** YAML frontmatter structure for agent definition files */
export interface AgentFrontmatter {
  name: string;
  description: string;
  /** Tools list: comma-separated string or array from YAML */
  tools?: string | string[];
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
