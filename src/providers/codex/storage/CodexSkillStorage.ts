import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { parseSlashCommandContent, serializeSlashCommandMarkdown } from '../../../utils/slashCommand';

export const CODEX_VAULT_SKILLS_PATH = '.codex/skills';
export const AGENTS_VAULT_SKILLS_PATH = '.agents/skills';

const VAULT_SCAN_ROOTS = [CODEX_VAULT_SKILLS_PATH, AGENTS_VAULT_SKILLS_PATH];
const HOME_SCAN_ROOTS = ['.codex/skills', '.agents/skills'];

export interface CodexSkillEntry {
  name: string;
  description?: string;
  content: string;
  provenance: 'vault' | 'home';
  /** Which root the skill was found in. */
  scanRoot: string;
}

export interface CodexSkillSaveInput {
  name: string;
  description?: string;
  content: string;
  scanRoot?: string;
}

export class CodexSkillStorage {
  constructor(
    private vaultAdapter: VaultFileAdapter,
    private homeAdapter?: VaultFileAdapter,
  ) {}

  async scanAll(): Promise<CodexSkillEntry[]> {
    const vaultSkills = await this.scanRoots(this.vaultAdapter, VAULT_SCAN_ROOTS, 'vault');
    const homeSkills = this.homeAdapter
      ? await this.scanRoots(this.homeAdapter, HOME_SCAN_ROOTS, 'home')
      : [];

    // Deduplicate: vault takes priority over home
    const seen = new Set(vaultSkills.map(s => s.name.toLowerCase()));
    const deduped = homeSkills.filter(s => !seen.has(s.name.toLowerCase()));

    return [...vaultSkills, ...deduped];
  }

  async scanVault(): Promise<CodexSkillEntry[]> {
    return this.scanRoots(this.vaultAdapter, VAULT_SCAN_ROOTS, 'vault');
  }

  async save(input: CodexSkillSaveInput): Promise<void> {
    const scanRoot = input.scanRoot ?? CODEX_VAULT_SKILLS_PATH;
    const dirPath = `${scanRoot}/${input.name}`;
    const filePath = `${dirPath}/SKILL.md`;

    await this.vaultAdapter.ensureFolder(dirPath);
    const markdown = serializeSlashCommandMarkdown(
      { name: input.name, description: input.description },
      input.content,
    );
    await this.vaultAdapter.write(filePath, markdown);
  }

  async delete(name: string, scanRoot: string = CODEX_VAULT_SKILLS_PATH): Promise<void> {
    const dirPath = `${scanRoot}/${name}`;
    const filePath = `${dirPath}/SKILL.md`;
    await this.vaultAdapter.delete(filePath);
    await this.vaultAdapter.deleteFolder(dirPath);
  }

  private async scanRoots(
    adapter: VaultFileAdapter,
    roots: string[],
    provenance: 'vault' | 'home',
  ): Promise<CodexSkillEntry[]> {
    const results: CodexSkillEntry[] = [];

    for (const root of roots) {
      try {
        const folders = await adapter.listFolders(root);
        for (const folder of folders) {
          const skillName = folder.split('/').pop()!;
          const skillPath = `${root}/${skillName}/SKILL.md`;

          try {
            if (!(await adapter.exists(skillPath))) continue;

            const content = await adapter.read(skillPath);
            const parsed = parseSlashCommandContent(content);

            results.push({
              name: skillName,
              description: parsed.description,
              content: parsed.promptContent,
              provenance,
              scanRoot: root,
            });
          } catch {
            // Skip malformed files
          }
        }
      } catch {
        // Root doesn't exist or can't be read
      }
    }

    return results;
  }
}
