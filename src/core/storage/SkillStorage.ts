import { parsedToSlashCommand, parseSlashCommandContent, serializeCommand } from '../../utils/slashCommand';
import type { SlashCommand } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

export const SKILLS_PATH = '.claude/skills';

export class SkillStorage {
  constructor(private adapter: VaultFileAdapter) {}

  async loadAll(): Promise<SlashCommand[]> {
    const skills: SlashCommand[] = [];

    try {
      const folders = await this.adapter.listFolders(SKILLS_PATH);

      for (const folder of folders) {
        const skillName = folder.split('/').pop()!;
        const skillPath = `${SKILLS_PATH}/${skillName}/SKILL.md`;

        try {
          if (!(await this.adapter.exists(skillPath))) continue;

          const content = await this.adapter.read(skillPath);
          const parsed = parseSlashCommandContent(content);

          skills.push(parsedToSlashCommand(parsed, {
            id: `skill-${skillName}`,
            name: skillName,
            source: 'user',
          }));
        } catch {
          // Non-critical: skip malformed skill files
        }
      }
    } catch {
      return [];
    }

    return skills;
  }

  async save(skill: SlashCommand): Promise<void> {
    const name = skill.name;
    const dirPath = `${SKILLS_PATH}/${name}`;
    const filePath = `${dirPath}/SKILL.md`;

    await this.adapter.ensureFolder(dirPath);
    await this.adapter.write(filePath, serializeCommand(skill));
  }

  async delete(skillId: string): Promise<void> {
    const name = skillId.replace(/^skill-/, '');
    const dirPath = `${SKILLS_PATH}/${name}`;
    const filePath = `${dirPath}/SKILL.md`;
    await this.adapter.delete(filePath);
    await this.adapter.deleteFolder(dirPath);
  }
}
