import { extractNumber, extractStringArray, normalizeStringArray, parseFrontmatter } from '../../utils/frontmatter';
import type { AgentFrontmatter } from '../types';

export function parseAgentFile(content: string): { frontmatter: AgentFrontmatter; body: string } | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;

  const { frontmatter: fm, body } = parsed;

  const name = fm.name;
  const description = fm.description;

  if (typeof name !== 'string' || !name.trim()) return null;
  if (typeof description !== 'string' || !description.trim()) return null;

  const tools = fm.tools;
  const disallowedTools = fm.disallowedTools;

  if (tools !== undefined && !isStringOrArray(tools)) return null;
  if (disallowedTools !== undefined && !isStringOrArray(disallowedTools)) return null;

  const model = typeof fm.model === 'string' ? fm.model : undefined;

  const frontmatter: AgentFrontmatter = {
    name,
    description,
    tools,
    disallowedTools,
    model,
    skills: extractStringArray(fm, 'skills'),
    maxTurns: extractNumber(fm, 'maxTurns'),
    mcpServers: Array.isArray(fm.mcpServers) ? fm.mcpServers : undefined,
  };

  return { frontmatter, body: body.trim() };
}

function isStringOrArray(value: unknown): value is string | string[] {
  return typeof value === 'string' || Array.isArray(value);
}

/** Returns undefined to inherit all tools. */
export function parseToolsList(tools?: string | string[]): string[] | undefined {
  return normalizeStringArray(tools);
}

const VALID_MODELS = ['sonnet', 'opus', 'haiku', 'inherit'] as const;

/** Falls back to 'inherit' for unrecognized values. */
export function parseModel(model?: string): 'sonnet' | 'opus' | 'haiku' | 'inherit' {
  if (!model) return 'inherit';
  const normalized = model.toLowerCase().trim();
  if (VALID_MODELS.includes(normalized as typeof VALID_MODELS[number])) {
    return normalized as 'sonnet' | 'opus' | 'haiku' | 'inherit';
  }
  return 'inherit';
}
