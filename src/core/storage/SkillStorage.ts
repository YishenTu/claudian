import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parsedToSlashCommand, parseSlashCommandContent, serializeCommand } from '../../utils/slashCommand';
import type { SlashCommand } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

export const SKILLS_PATH = '.claude/skills';
export const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

export class SkillStorage {
  constructor(private adapter: VaultFileAdapter) { }

  async loadAll(): Promise<SlashCommand[]> {
    const skills: SlashCommand[] = [];
    const loadedNames = new Set<string>();

    try {
      if (await this.adapter.exists(SKILLS_PATH)) {
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
            loadedNames.add(skillName);
          } catch {
            // Non-critical: skip malformed skill files
          }
        }
      }
    } catch {
      // Non-critical: skip vault skills if directory missing or inaccessible
    }

    // Also load user-level skills from ~/.claude/skills (global Claude Code skills).
    // Vault skills take precedence: if a skill with the same name already loaded, skip.
    this.loadGlobalSkills(skills, loadedNames);

    return skills;
  }

  private loadGlobalSkills(skills: SlashCommand[], loadedNames: Set<string>): void {
    try {
      if (!fs.existsSync(GLOBAL_SKILLS_DIR)) return;

      const entries = fs.readdirSync(GLOBAL_SKILLS_DIR, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillName = entry.name;
        if (loadedNames.has(skillName)) continue; // Vault skill wins

        const skillPath = path.join(GLOBAL_SKILLS_DIR, skillName, 'SKILL.md');

        try {
          if (!fs.existsSync(skillPath)) continue;

          const content = fs.readFileSync(skillPath, 'utf-8');
          const parsed = parseSlashCommandContent(content);

          skills.push(parsedToSlashCommand(parsed, {
            id: `skill-global-${skillName}`,
            name: skillName,
            source: 'user',
          }));
        } catch {
          // Non-critical: skip malformed global skill files
        }
      }
    } catch {
      // Non-critical: global skills directory may be inaccessible
    }
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
