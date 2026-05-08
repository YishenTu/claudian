import * as path from 'node:path';

import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { extractBoolean, isRecord, parseFrontmatter } from '../../../utils/frontmatter';
import { yamlString } from '../../../utils/slashCommand';
import {
  GEMINI_AGENT_KNOWN_KEYS,
  type GeminiAgentDefinition,
} from '../types/agent';

export const GEMINI_AGENT_PATH = '.gemini/agent';
export const GEMINI_AGENTS_PATH = '.gemini/agents';
const GEMINI_AGENT_SCAN_PATHS = [
  GEMINI_AGENTS_PATH,
  GEMINI_AGENT_PATH,
] as const;
const GEMINI_DEFAULT_AGENT_SAVE_PATH = GEMINI_AGENT_PATH;
const GEMINI_AGENT_PERSISTENCE_PREFIX = 'gemini-agent';

export interface GeminiAgentLocation {
  filePath: string;
}

export function createGeminiAgentPersistenceKey(
  location: GeminiAgentLocation,
): string {
  return `${GEMINI_AGENT_PERSISTENCE_PREFIX}:${encodeURIComponent(normalizeVaultPath(location.filePath))}`;
}

export function parseGeminiAgentPersistenceKey(
  persistenceKey?: string,
): GeminiAgentLocation | null {
  if (!persistenceKey) {
    return null;
  }

  const normalizedKey = normalizeVaultPath(persistenceKey);
  if (isSupportedAgentFilePath(normalizedKey)) {
    return { filePath: normalizedKey };
  }

  const [prefix, encodedRelativePath] = persistenceKey.split(':');
  if (prefix !== GEMINI_AGENT_PERSISTENCE_PREFIX || !encodedRelativePath) {
    return null;
  }

  const decoded = normalizeVaultPath(decodeURIComponent(encodedRelativePath));
  if (isSupportedAgentFilePath(decoded)) {
    return { filePath: decoded };
  }

  return decoded.endsWith('.md')
    ? { filePath: `${GEMINI_AGENTS_PATH}/${decoded}` }
    : null;
}

export class GeminiAgentStorage {
  constructor(
    private vaultAdapter: Pick<VaultFileAdapter, 'exists' | 'read' | 'write' | 'delete' | 'listFilesRecursive' | 'ensureFolder'>,
  ) {}

  async loadAll(): Promise<GeminiAgentDefinition[]> {
    return this.scanAdapter(this.vaultAdapter);
  }

  async load(agent: GeminiAgentDefinition): Promise<GeminiAgentDefinition | null> {
    const filePath = this.resolveCurrentPath(agent);
    try {
      if (!(await this.vaultAdapter.exists(filePath))) return null;
      const content = await this.vaultAdapter.read(filePath);
      return parseGeminiAgentMarkdown(content, filePath);
    } catch {
      return null;
    }
  }

  async save(agent: GeminiAgentDefinition, previous?: GeminiAgentDefinition | null): Promise<void> {
    const filePath = this.resolveTargetPath(agent, previous);
    const previousPath = previous ? this.resolveCurrentPath(previous) : null;
    await this.vaultAdapter.ensureFolder(path.posix.dirname(filePath));
    const content = serializeGeminiAgentMarkdown(agent);
    await this.vaultAdapter.write(filePath, content);

    if (previousPath && previousPath !== filePath) {
      await this.vaultAdapter.delete(previousPath);
    }
  }

  async delete(agent: GeminiAgentDefinition): Promise<void> {
    const filePath = this.resolveCurrentPath(agent);
    await this.vaultAdapter.delete(filePath);
  }

  private resolveCurrentPath(agent: GeminiAgentDefinition): string {
    const persistedLocation = parseGeminiAgentPersistenceKey(agent.persistenceKey);
    if (persistedLocation) {
      return persistedLocation.filePath;
    }

    return `${GEMINI_DEFAULT_AGENT_SAVE_PATH}/${agent.name}.md`;
  }

  private resolveTargetPath(
    agent: GeminiAgentDefinition,
    previous?: GeminiAgentDefinition | null,
  ): string {
    if (previous && previous.name === agent.name) {
      return this.resolveCurrentPath(previous);
    }

    return `${GEMINI_DEFAULT_AGENT_SAVE_PATH}/${agent.name}.md`;
  }

  private async scanAdapter(
    adapter: Pick<VaultFileAdapter, 'read' | 'listFilesRecursive'>,
  ): Promise<GeminiAgentDefinition[]> {
    const agentsByName = new Map<string, GeminiAgentDefinition>();

    for (const rootPath of GEMINI_AGENT_SCAN_PATHS) {
      try {
        const files = await adapter.listFilesRecursive(rootPath);
        for (const filePath of files) {
          if (!filePath.endsWith('.md')) continue;
          try {
            const content = await adapter.read(filePath);
            const agent = parseGeminiAgentMarkdown(content, filePath);
            if (!agent) continue;

            const dedupeKey = agent.name.toLowerCase();
            agentsByName.delete(dedupeKey);
            agentsByName.set(dedupeKey, agent);
          } catch {
            // Skip malformed files
          }
        }
      } catch {
        // Directory doesn't exist yet
      }
    }

    return Array.from(agentsByName.values());
  }
}

export function parseGeminiAgentMarkdown(
  content: string,
  filePath: string,
): GeminiAgentDefinition | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    return null;
  }

  const fileName = normalizeAgentNameFromPath(filePath);
  const frontmatter = parsed.frontmatter;
  const rawName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const name = rawName || fileName;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';

  if (!name || !description) {
    return null;
  }

  const result: GeminiAgentDefinition = {
    name,
    description,
    prompt: parsed.body.trim(),
    persistenceKey: createGeminiAgentPersistenceKey({
      filePath: normalizeVaultPath(filePath),
    }),
  };

  const mode = normalizeMode(frontmatter.mode);
  if (mode) result.mode = mode;

  if (typeof frontmatter.model === 'string' && frontmatter.model.trim()) {
    result.model = frontmatter.model.trim();
  }
  if (typeof frontmatter.variant === 'string' && frontmatter.variant.trim()) {
    result.variant = frontmatter.variant.trim();
  }
  if (typeof frontmatter.temperature === 'number' && Number.isFinite(frontmatter.temperature)) {
    result.temperature = frontmatter.temperature;
  }
  const topP = normalizeFiniteNumber(frontmatter.top_p);
  if (topP !== undefined) {
    result.topP = topP;
  }
  if (typeof frontmatter.color === 'string' && frontmatter.color.trim()) {
    result.color = frontmatter.color.trim();
  }

  const steps = normalizePositiveInteger(frontmatter.steps) ?? normalizePositiveInteger(frontmatter.maxSteps);
  if (steps !== undefined) {
    result.steps = steps;
  }

  if (extractBoolean(frontmatter, 'hidden') !== undefined) {
    result.hidden = extractBoolean(frontmatter, 'hidden');
  }
  if (extractBoolean(frontmatter, 'disable') !== undefined) {
    result.disable = extractBoolean(frontmatter, 'disable');
  }

  if (isBooleanRecord(frontmatter.tools)) {
    result.tools = { ...frontmatter.tools };
  }
  if (isRecord(frontmatter.options)) {
    result.options = { ...frontmatter.options };
  }
  if (frontmatter.permission !== undefined) {
    result.permission = frontmatter.permission;
  }

  const extraFrontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!GEMINI_AGENT_KNOWN_KEYS.has(key)) {
      extraFrontmatter[key] = value;
    }
  }
  if (Object.keys(extraFrontmatter).length > 0) {
    result.extraFrontmatter = extraFrontmatter;
  }

  return result;
}

export function serializeGeminiAgentMarkdown(agent: GeminiAgentDefinition): string {
  const lines: string[] = ['---'];

  lines.push(`name: ${yamlString(agent.name)}`);
  lines.push(`description: ${yamlString(agent.description)}`);

  if (agent.mode) {
    lines.push(`mode: ${agent.mode}`);
  }
  if (agent.model) {
    lines.push(`model: ${serializeYamlValue(agent.model)}`);
  }
  if (agent.variant) {
    lines.push(`variant: ${serializeYamlValue(agent.variant)}`);
  }
  if (agent.temperature !== undefined) {
    lines.push(`temperature: ${serializeYamlValue(agent.temperature)}`);
  }
  if (agent.topP !== undefined) {
    lines.push(`top_p: ${serializeYamlValue(agent.topP)}`);
  }
  if (agent.color) {
    lines.push(`color: ${serializeYamlValue(agent.color)}`);
  }
  if (agent.steps !== undefined) {
    lines.push(`steps: ${serializeYamlValue(agent.steps)}`);
  }
  if (agent.hidden) {
    lines.push('hidden: true');
  }
  if (agent.disable) {
    lines.push('disable: true');
  }
  if (agent.tools && Object.keys(agent.tools).length > 0) {
    lines.push(`tools: ${serializeYamlValue(agent.tools)}`);
  }
  if (agent.options && Object.keys(agent.options).length > 0) {
    lines.push(`options: ${serializeYamlValue(agent.options)}`);
  }
  if (agent.permission !== undefined) {
    lines.push(`permission: ${serializeYamlValue(agent.permission)}`);
  }

  if (agent.extraFrontmatter) {
    for (const [key, value] of Object.entries(agent.extraFrontmatter)) {
      lines.push(`${key}: ${serializeYamlValue(value)}`);
    }
  }

  lines.push('---');
  lines.push(agent.prompt);

  return lines.join('\n');
}

function normalizeAgentNameFromPath(filePath: string): string {
  const relativePath = toRelativeAgentPath(filePath);
  return relativePath.replace(/\.md$/i, '');
}

function toRelativeAgentPath(filePath: string): string {
  const normalized = normalizeVaultPath(filePath);

  for (const rootPath of GEMINI_AGENT_SCAN_PATHS) {
    const prefix = `${rootPath}/`;
    const index = normalized.lastIndexOf(prefix);
    if (index >= 0) {
      return normalized.slice(index + prefix.length);
    }
  }

  return normalized.split('/').pop() ?? normalized;
}

function normalizeMode(value: unknown): GeminiAgentDefinition['mode'] | undefined {
  return value === 'subagent' || value === 'primary' || value === 'all'
    ? value
    : undefined;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'boolean');
}

function serializeYamlValue(value: unknown): string {
  if (typeof value === 'string') {
    return yamlString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return JSON.stringify(value);
}

function normalizeVaultPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isSupportedAgentFilePath(filePath: string): boolean {
  return GEMINI_AGENT_SCAN_PATHS.some((rootPath) => filePath.startsWith(`${rootPath}/`))
    && filePath.endsWith('.md');
}
