/**
 * Claudian - Skill Storage
 *
 * Prioritizes global Claude Code config (~/.claude/skills/) over vault config.
 * This ensures Claudian uses the same skills as Claude Code CLI.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parsedToSlashCommand, parseSlashCommandContent, serializeCommand } from '../../utils/slashCommand';
import type { SlashCommand } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

export const SKILLS_PATH = '.claude/skills';
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

export class SkillStorage {
  private useGlobal: boolean;

  constructor(
    private adapter: VaultFileAdapter,
    options?: { preferGlobal?: boolean }
  ) {
    // Default to global config (Claude Code CLI compatibility)
    this.useGlobal = options?.preferGlobal ?? true;
  }

  /**
   * Load all skills. Prioritizes global skills over vault skills.
   * Vault skills with the same name as global skills are ignored (global takes precedence).
   */
  async loadAll(): Promise<SlashCommand[]> {
    const skills: SlashCommand[] = [];
    const globalSkillNames = new Set<string>();

    // Load global skills first (higher priority)
    if (this.useGlobal) {
      const globalSkills = await this.loadGlobal();
      for (const skill of globalSkills) {
        skills.push(skill);
        globalSkillNames.add(skill.name);
      }
    }

    // Load vault skills (skip if global skill with same name exists)
    try {
      const folders = await this.adapter.listFolders(SKILLS_PATH);

      for (const folder of folders) {
        const skillName = folder.split('/').pop()!;

        // Skip if global skill with same name exists
        if (globalSkillNames.has(skillName)) continue;

        const skillPath = `${SKILLS_PATH}/${skillName}/SKILL.md`;

        try {
          if (!(await this.adapter.exists(skillPath))) continue;

          const content = await this.adapter.read(skillPath);
          const parsed = parseSlashCommandContent(content);

          skills.push(parsedToSlashCommand(parsed, {
            id: `skill-${skillName}`,
            name: skillName,
            source: 'vault',
          }));
        } catch {
          // Non-critical: skip malformed skill files
        }
      }
    } catch {
      // Non-critical: directory may not exist yet
    }

    return skills;
  }

  /**
   * Load skills from global ~/.claude/skills/ directory.
   * Shared across all vaults and with Claude Code CLI.
   */
  async loadGlobal(): Promise<SlashCommand[]> {
    const skills: SlashCommand[] = [];

    if (!fs.existsSync(GLOBAL_SKILLS_DIR)) {
      return skills;
    }

    try {
      const entries = fs.readdirSync(GLOBAL_SKILLS_DIR, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillName = entry.name;
        const skillMdPath = path.join(GLOBAL_SKILLS_DIR, skillName, 'SKILL.md');

        try {
          if (!fs.existsSync(skillMdPath)) continue;

          const content = fs.readFileSync(skillMdPath, 'utf-8');
          const parsed = parseSlashCommandContent(content);

          skills.push(parsedToSlashCommand(parsed, {
            id: `skill-${skillName}`,
            name: skillName,
            source: 'global',
          }));
        } catch {
          // Non-critical: skip malformed skill files
        }
      }
    } catch {
      // Non-critical: directory may be unreadable
    }

    return skills;
  }

  async save(skill: SlashCommand): Promise<void> {
    const name = skill.name;

    if (this.useGlobal) {
      // Save to global location
      const dirPath = path.join(GLOBAL_SKILLS_DIR, name);
      const filePath = path.join(dirPath, 'SKILL.md');

      // Ensure directory exists
      if (!fs.existsSync(GLOBAL_SKILLS_DIR)) {
        fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
      }
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      fs.writeFileSync(filePath, serializeCommand(skill), 'utf-8');
    } else {
      // Save to vault location
      const dirPath = `${SKILLS_PATH}/${name}`;
      const filePath = `${dirPath}/SKILL.md`;

      await this.adapter.ensureFolder(dirPath);
      await this.adapter.write(filePath, serializeCommand(skill));
    }
  }

  async delete(skillId: string): Promise<void> {
    const name = skillId.replace(/^skill-/, '');

    if (this.useGlobal) {
      // Delete from global location
      const dirPath = path.join(GLOBAL_SKILLS_DIR, name);
      const filePath = path.join(dirPath, 'SKILL.md');

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } else {
      // Delete from vault location
      const dirPath = `${SKILLS_PATH}/${name}`;
      const filePath = `${dirPath}/SKILL.md`;
      await this.adapter.delete(filePath);
      await this.adapter.deleteFolder(dirPath);
    }
  }
}
