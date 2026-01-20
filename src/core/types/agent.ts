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

  /** Disallowed tools. Removed from inherited or specified tools list */
  disallowedTools?: string[];

  /** Model override. 'inherit' (default) uses parent's model */
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';

  /** Source of the agent definition */
  source: 'plugin' | 'vault' | 'global' | 'builtin';

  /** Plugin name (only for plugin-sourced agents) */
  pluginName?: string;

  /** Absolute path to the source .md file (undefined for built-in agents) */
  filePath?: string;
}

/** YAML frontmatter structure for agent definition files */
export interface AgentFrontmatter {
  name: string;
  description: string;
  /** Tools list: comma-separated string or array from YAML */
  tools?: string | string[];
  /** Disallowed tools: comma-separated string or array from YAML */
  disallowedTools?: string | string[];
  /** Model: validated at parse time, invalid values fall back to 'inherit' */
  model?: string;
}
