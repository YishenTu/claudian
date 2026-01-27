import type { AgentMcpServerSpec } from '@anthropic-ai/claude-agent-sdk';

/**
 * Agent definition loaded from markdown files with YAML frontmatter.
 * Matches Claude Code's agent format for compatibility.
 */
export interface AgentDefinition {
  /** Unique identifier. Namespaced for plugins: "plugin-name:agent-name" */
  id: string;

  /** Display name (from YAML `name` field) */
  name: string;

  description: string;

  /** System prompt for the agent (markdown body after frontmatter) */
  prompt: string;

  /** Allowed tools. If undefined, inherits all tools from parent */
  tools?: string[];

  /** Disallowed tools. Removed from inherited or specified tools list */
  disallowedTools?: string[];

  /** Model override. 'inherit' (default) uses parent's model */
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';

  source: 'plugin' | 'vault' | 'global' | 'builtin';

  /** Plugin name (only for plugin-sourced agents) */
  pluginName?: string;

  /** Absolute path to the source .md file (undefined for built-in agents) */
  filePath?: string;

  /** Skills available to this agent (pass-through to SDK) */
  skills?: string[];

  /** Max agent turns before stopping (pass-through to SDK) */
  maxTurns?: number;

  /** MCP server specs (pass-through to SDK) */
  mcpServers?: AgentMcpServerSpec[];
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
  /** Skills available to this agent (pass-through to SDK) */
  skills?: string[];
  /** Max agent turns before stopping */
  maxTurns?: number;
  /** MCP server specs (pass-through raw to SDK) */
  mcpServers?: AgentMcpServerSpec[];
}
