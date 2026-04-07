export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  source: 'plugin' | 'vault' | 'global' | 'builtin';
  pluginName?: string;
  filePath?: string;
  skills?: string[];
  permissionMode?: string;
  hooks?: Record<string, unknown>;
  extraFrontmatter?: Record<string, unknown>;
}

export interface AgentFrontmatter {
  name: string;
  description: string;
  tools?: string | string[];
  disallowedTools?: string | string[];
  model?: string;
  skills?: string[];
  permissionMode?: string;
  hooks?: Record<string, unknown>;
  extraFrontmatter?: Record<string, unknown>;
}
