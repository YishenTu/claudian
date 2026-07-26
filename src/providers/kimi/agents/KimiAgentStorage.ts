import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { normalizeStringArray, parseFrontmatter } from '../../../utils/frontmatter';
import { yamlString } from '../../../utils/slashCommand';

export const KIMI_BRAND_AGENTS_PATH = '.kimi-code/agents';
export const KIMI_GENERIC_AGENTS_PATH = '.agents/agents';

// Generic first so brand-directory agents win name conflicts, mirroring
// kimi-code's brand-over-generic root precedence.
const KIMI_AGENT_SCAN_PATHS = [
  KIMI_GENERIC_AGENTS_PATH,
  KIMI_BRAND_AGENTS_PATH,
] as const;

// Kebab-case names, matching kimi-code's agentFile parser.
const KIMI_AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Frontmatter keys Claudian manages; everything else (override, whenToUse,
// subagents, unknown future keys) round-trips through extraFrontmatter.
const KIMI_AGENT_MANAGED_KEYS = new Set([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model_preference',
]);

export interface KimiAgentDefinition {
  description: string;
  disallowedTools?: string[];
  extraFrontmatter?: Record<string, unknown>;
  filePath: string;
  modelPreference?: 'primary' | 'secondary';
  name: string;
  prompt: string;
  tools?: string[];
}

export function validateKimiAgentName(name: string): string | null {
  if (!name) {
    return 'Agent name is required';
  }
  if (!KIMI_AGENT_NAME_PATTERN.test(name)) {
    return 'Agent name can only contain lowercase letters, numbers, and single hyphens between segments';
  }
  return null;
}

function validateKimiAgent(agent: KimiAgentDefinition): void {
  const nameError = validateKimiAgentName(agent.name);
  if (nameError) {
    throw new Error(nameError);
  }
  if (!agent.description.trim()) {
    throw new Error('Description is required');
  }
  if (!agent.prompt.trim()) {
    throw new Error('System prompt is required');
  }
}

// Vault scan + brand-directory writes. Reads cover both agent directories
// (kimi loads both natively); writes only ever target `.kimi-code/agents/` —
// the shared generic directory stays untouched.
export class KimiAgentStorage {
  constructor(
    private vaultAdapter: Pick<
      VaultFileAdapter,
      'delete' | 'exists' | 'listFilesRecursive' | 'read' | 'write'
    >,
  ) {}

  async loadAll(): Promise<KimiAgentDefinition[]> {
    const agentsByName = new Map<string, KimiAgentDefinition>();

    for (const rootPath of KIMI_AGENT_SCAN_PATHS) {
      let files: string[];
      try {
        files = await this.vaultAdapter.listFilesRecursive(rootPath);
      } catch {
        continue;
      }

      for (const filePath of files) {
        if (!filePath.endsWith('.md')) {
          continue;
        }
        try {
          const agent = parseKimiAgentMarkdown(await this.vaultAdapter.read(filePath), filePath);
          if (!agent) {
            continue;
          }
          agentsByName.delete(agent.name);
          agentsByName.set(agent.name, agent);
        } catch {
          // Skip malformed files.
        }
      }
    }

    return [...agentsByName.values()];
  }

  async save(agent: KimiAgentDefinition, previous?: KimiAgentDefinition | null): Promise<void> {
    validateKimiAgent(agent);
    const filePath = `${KIMI_BRAND_AGENTS_PATH}/${agent.name}.md`;
    await this.vaultAdapter.write(filePath, serializeKimiAgentMarkdown(agent));

    if (
      previous
      && previous.filePath !== filePath
      && previous.filePath.startsWith(`${KIMI_BRAND_AGENTS_PATH}/`)
    ) {
      await this.vaultAdapter.delete(previous.filePath);
    }
  }

  async delete(agent: KimiAgentDefinition): Promise<void> {
    if (!agent.filePath.startsWith(`${KIMI_BRAND_AGENTS_PATH}/`)) {
      throw new Error(`Agent "${agent.name}" does not live in ${KIMI_BRAND_AGENTS_PATH}`);
    }
    await this.vaultAdapter.delete(agent.filePath);
  }
}

// Parses the kimi agent Markdown format: YAML frontmatter with `name` (falls
// back to the file name), required `description`, and a non-empty prompt body.
// Files kimi itself would refuse (invalid name, missing description/prompt)
// are skipped here too. Unmanaged frontmatter keys are preserved in
// `extraFrontmatter` so edits stay forward-compatible.
export function parseKimiAgentMarkdown(
  content: string,
  filePath: string,
): KimiAgentDefinition | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    return null;
  }

  const frontmatter = parsed.frontmatter;
  const rawName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const name = rawName || deriveNameFromPath(filePath);
  if (!KIMI_AGENT_NAME_PATTERN.test(name)) {
    return null;
  }

  const description = typeof frontmatter.description === 'string'
    ? frontmatter.description.trim()
    : '';
  const prompt = parsed.body.trim();
  if (!description || !prompt) {
    return null;
  }

  const agent: KimiAgentDefinition = { description, filePath, name, prompt };

  const tools = normalizeKimiToolList(frontmatter.tools);
  if (tools) {
    agent.tools = tools;
  }
  const disallowedTools = normalizeStringArray(frontmatter.disallowedTools);
  if (disallowedTools && disallowedTools.length > 0) {
    agent.disallowedTools = disallowedTools;
  }
  if (frontmatter.model_preference === 'primary' || frontmatter.model_preference === 'secondary') {
    agent.modelPreference = frontmatter.model_preference;
  }

  const extraFrontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!KIMI_AGENT_MANAGED_KEYS.has(key)) {
      extraFrontmatter[key] = value;
    }
  }
  if (Object.keys(extraFrontmatter).length > 0) {
    agent.extraFrontmatter = extraFrontmatter;
  }

  return agent;
}

export function serializeKimiAgentMarkdown(agent: KimiAgentDefinition): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${yamlString(agent.name)}`);
  lines.push(`description: ${yamlString(agent.description)}`);
  pushYamlList(lines, 'tools', agent.tools);
  pushYamlList(lines, 'disallowedTools', agent.disallowedTools);
  if (agent.modelPreference) {
    lines.push(`model_preference: ${agent.modelPreference}`);
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

// A lone `*` means unrestricted, same as an omitted field (kimi convention).
function normalizeKimiToolList(value: unknown): string[] | undefined {
  const list = normalizeStringArray(value);
  if (!list || list.length === 0 || (list.length === 1 && list[0] === '*')) {
    return undefined;
  }
  return list;
}

function pushYamlList(lines: string[], key: string, items?: string[]): void {
  if (!items || items.length === 0) {
    return;
  }
  lines.push(`${key}:`);
  for (const item of items) {
    lines.push(`  - ${yamlString(item)}`);
  }
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

function deriveNameFromPath(filePath: string): string {
  const base = filePath.split('/').pop() ?? '';
  return base.replace(/\.md$/i, '');
}
