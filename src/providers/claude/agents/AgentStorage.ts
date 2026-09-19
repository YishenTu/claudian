import { extractStringArray, isRecord, normalizeStringArray, parseFrontmatter } from '../../../utils/frontmatter';
import { isClaudeModelTier } from '../modelTiers';
import type { AgentDefinition, AgentFrontmatter } from '../types/agent';
import { AGENT_PERMISSION_MODES, type AgentPermissionMode } from '../types/agent';

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
    permissionMode: parsePermissionMode(fm.permissionMode),
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

export function parsePermissionMode(mode?: unknown): AgentPermissionMode | undefined {
  if (mode === undefined) return undefined;
  const trimmed = typeof mode === 'string' ? mode.trim() : '';
  if (trimmed === 'manual') return 'default';
  if ((AGENT_PERMISSION_MODES as readonly string[]).includes(trimmed)) {
    return trimmed as AgentPermissionMode;
  }
  throw new Error(`Unsupported agent permission mode: ${String(mode)}`);
}

export function parseModel(model?: string): string {
  if (!model) return 'inherit';
  const normalized = model.toLowerCase().trim();
  if (normalized === 'inherit' || isClaudeModelTier(normalized)) {
    return normalized;
  }
  return model.trim() || 'inherit';
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
