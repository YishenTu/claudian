/**
 * SkillStorage - Loads skills from .claude/skills/<name>/SKILL.md
 *
 * Each skill is a directory under .claude/skills/ containing a SKILL.md file
 * with YAML frontmatter and prompt content.
 */

import { parseSlashCommandContent } from '../../utils/slashCommand';
import type { ClaudeModel, SlashCommand } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

export const SKILLS_PATH = '.claude/skills';

export class SkillStorage {
  constructor(private adapter: VaultFileAdapter) {}

  async loadAll(): Promise<SlashCommand[]> {
    const skills: SlashCommand[] = [];

    if (!(await this.adapter.exists(SKILLS_PATH))) {
      return skills;
    }

    const folders = await this.adapter.listFolders(SKILLS_PATH);

    for (const folder of folders) {
      const skillName = folder.split('/').pop()!;
      const skillPath = `${SKILLS_PATH}/${skillName}/SKILL.md`;

      try {
        if (!(await this.adapter.exists(skillPath))) continue;

        const content = await this.adapter.read(skillPath);
        const parsed = parseSlashCommandContent(content);

        skills.push({
          id: `skill-${skillName}`,
          name: skillName,
          description: parsed.description,
          argumentHint: parsed.argumentHint,
          allowedTools: parsed.allowedTools,
          model: parsed.model as ClaudeModel | undefined,
          content: parsed.promptContent,
          source: 'user',
          disableModelInvocation: parsed.disableModelInvocation,
          userInvocable: parsed.userInvocable,
          context: parsed.context,
          agent: parsed.agent,
          hooks: parsed.hooks,
        });
      } catch {
        // Skip skills that fail to load
      }
    }

    return skills;
  }

  async save(skill: SlashCommand): Promise<void> {
    const name = skill.name;
    const dirPath = `${SKILLS_PATH}/${name}`;
    const filePath = `${dirPath}/SKILL.md`;

    await this.adapter.ensureFolder(dirPath);

    const lines: string[] = ['---'];

    if (skill.description) {
      lines.push(`description: ${this.yamlString(skill.description)}`);
    }
    if (skill.argumentHint) {
      lines.push(`argument-hint: ${this.yamlString(skill.argumentHint)}`);
    }
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      lines.push('allowed-tools:');
      for (const tool of skill.allowedTools) {
        lines.push(`  - ${tool}`);
      }
    }
    if (skill.model) {
      lines.push(`model: ${skill.model}`);
    }
    if (skill.disableModelInvocation !== undefined) {
      lines.push(`disableModelInvocation: ${skill.disableModelInvocation}`);
    }
    if (skill.userInvocable !== undefined) {
      lines.push(`userInvocable: ${skill.userInvocable}`);
    }
    if (skill.context) {
      lines.push(`context: ${skill.context}`);
    }
    if (skill.agent) {
      lines.push(`agent: ${skill.agent}`);
    }
    if (skill.hooks !== undefined) {
      lines.push(`hooks: ${JSON.stringify(skill.hooks)}`);
    }

    if (lines.length === 1) {
      lines.push('');
    }

    lines.push('---');
    lines.push(skill.content);

    await this.adapter.write(filePath, lines.join('\n'));
  }

  async delete(skillId: string): Promise<void> {
    const name = skillId.replace(/^skill-/, '');
    const dirPath = `${SKILLS_PATH}/${name}`;
    const filePath = `${dirPath}/SKILL.md`;
    await this.adapter.delete(filePath);
    await this.adapter.deleteFolder(dirPath);
  }

  private yamlString(value: string): string {
    if (value.includes(':') || value.includes('#') || value.includes('\n') ||
        value.startsWith(' ') || value.endsWith(' ')) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
}
