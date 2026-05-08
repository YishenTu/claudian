export interface GeminiAgentDefinition {
  name: string;
  description: string;
  prompt: string;
  mode?: 'subagent' | 'primary' | 'all';
  hidden?: boolean;
  model?: string;
  variant?: string;
  temperature?: number;
  topP?: number;
  color?: string;
  steps?: number;
  disable?: boolean;
  tools?: Record<string, boolean>;
  options?: Record<string, unknown>;
  permission?: unknown;
  persistenceKey?: string;
  extraFrontmatter?: Record<string, unknown>;
}

export const GEMINI_AGENT_KNOWN_KEYS = new Set([
  'name',
  'description',
  'mode',
  'model',
  'variant',
  'temperature',
  'top_p',
  'steps',
  'maxSteps',
  'hidden',
  'color',
  'disable',
  'tools',
  'options',
  'permission',
]);
