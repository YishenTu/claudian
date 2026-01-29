import { extractStringArray, isRecord, normalizeStringArray, parseFrontmatter } from '../../utils/frontmatter';
import { AGENT_PERMISSION_MODES, type AgentDefinition, type AgentFrontmatter, type AgentPermissionMode } from '../types';

const KNOWN_AGENT_KEYS = new Set([
  'name', 'description', 'tools', 'disallowedTools', 'model',
  'skills', 'permissionMode', 'hooks',
]);

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

  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(fm)) {
    if (!KNOWN_AGENT_KEYS.has(key)) {
      extra[key] = fm[key];
    }
  }

  const frontmatter: AgentFrontmatter = {
    name,
    description,
    tools,
    disallowedTools,
    model,
    skills: extractStringArray(fm, 'skills'),
    permissionMode: typeof fm.permissionMode === 'string' ? fm.permissionMode : undefined,
    hooks: isRecord(fm.hooks) ? fm.hooks : undefined,
    extraFrontmatter: Object.keys(extra).length > 0 ? extra : undefined,
  };

  return { frontmatter, body: body.trim() };
}

function isStringOrArray(value: unknown): value is string | string[] {
  return typeof value === 'string' || Array.isArray(value);
}

export function parseToolsList(tools?: string | string[]): string[] | undefined {
  return normalizeStringArray(tools);
}

export function parsePermissionMode(mode?: string): AgentPermissionMode | undefined {
  if (!mode) return undefined;
  const trimmed = mode.trim();
  if ((AGENT_PERMISSION_MODES as readonly string[]).includes(trimmed)) {
    return trimmed as AgentPermissionMode;
  }
  return undefined;
}

const VALID_MODELS = ['sonnet', 'opus', 'haiku', 'inherit'] as const;

export function parseModel(model?: string): 'sonnet' | 'opus' | 'haiku' | 'inherit' {
  if (!model) return 'inherit';
  const normalized = model.toLowerCase().trim();
  if (VALID_MODELS.includes(normalized as typeof VALID_MODELS[number])) {
    return normalized as 'sonnet' | 'opus' | 'haiku' | 'inherit';
  }
  return 'inherit';
}

export function buildAgentFromFrontmatter(
  frontmatter: AgentFrontmatter,
  body: string,
  meta: { id: string; source: AgentDefinition['source']; filePath?: string; pluginName?: string }
): AgentDefinition {
  return {
    id: meta.id,
    name: frontmatter.name,
    description: frontmatter.description,
    prompt: body,
    tools: parseToolsList(frontmatter.tools),
    disallowedTools: parseToolsList(frontmatter.disallowedTools),
    model: parseModel(frontmatter.model),
    source: meta.source,
    filePath: meta.filePath,
    pluginName: meta.pluginName,
    skills: frontmatter.skills,
    permissionMode: parsePermissionMode(frontmatter.permissionMode),
    hooks: frontmatter.hooks,
    extraFrontmatter: frontmatter.extraFrontmatter,
  };
}
