import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { parseFrontmatter } from '../../../utils/frontmatter';

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

export interface KimiAgentDefinition {
  description: string;
  filePath: string;
  name: string;
  prompt: string;
}

// Read-only vault scan: agent files stay user-owned (kimi loads them natively);
// Claudian only surfaces them for @-mentions.
export class KimiAgentStorage {
  constructor(
    private vaultAdapter: Pick<VaultFileAdapter, 'listFilesRecursive' | 'read'>,
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
}

// Parses the kimi agent Markdown format: YAML frontmatter with `name` (falls
// back to the file name), required `description`, and a non-empty prompt body.
// Files kimi itself would refuse (invalid name, missing description/prompt)
// are skipped here too.
export function parseKimiAgentMarkdown(
  content: string,
  filePath: string,
): KimiAgentDefinition | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    return null;
  }

  const rawName = typeof parsed.frontmatter.name === 'string'
    ? parsed.frontmatter.name.trim()
    : '';
  const name = rawName || deriveNameFromPath(filePath);
  if (!KIMI_AGENT_NAME_PATTERN.test(name)) {
    return null;
  }

  const description = typeof parsed.frontmatter.description === 'string'
    ? parsed.frontmatter.description.trim()
    : '';
  const prompt = parsed.body.trim();
  if (!description || !prompt) {
    return null;
  }

  return { description, filePath, name, prompt };
}

function deriveNameFromPath(filePath: string): string {
  const base = filePath.split('/').pop() ?? '';
  return base.replace(/\.md$/i, '');
}
