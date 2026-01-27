import type { ClaudeModel, SlashCommand } from '../core/types';
import {
  extractBoolean,
  extractString,
  extractStringArray,
  parseFrontmatter,
} from './frontmatter';

export interface ParsedSlashCommandContent {
  description?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  promptContent: string;
  // Skill fields
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  context?: 'fork';
  agent?: string;
  hooks?: Record<string, unknown>;
}

const MAX_COMMAND_NAME_LENGTH = 64;
const COMMAND_NAME_PATTERN = /^[a-z0-9-]+$/;

export function extractFirstParagraph(content: string): string | undefined {
  const paragraph = content.split(/\n\s*\n/).find(p => p.trim());
  if (!paragraph) return undefined;
  return paragraph.trim().replace(/\n/g, ' ');
}

export function validateCommandName(name: string): string | null {
  if (!name) {
    return 'Command name is required';
  }
  if (name.length > MAX_COMMAND_NAME_LENGTH) {
    return `Command name must be ${MAX_COMMAND_NAME_LENGTH} characters or fewer`;
  }
  if (!COMMAND_NAME_PATTERN.test(name)) {
    return 'Command name can only contain lowercase letters, numbers, and hyphens';
  }
  return null;
}

export function isUserCommand(cmd: SlashCommand): boolean {
  return !cmd.id.startsWith('plugin-');
}

export function isSkill(cmd: SlashCommand): boolean {
  return cmd.id.startsWith('skill-');
}

export function parsedToSlashCommand(
  parsed: ParsedSlashCommandContent,
  identity: Pick<SlashCommand, 'id' | 'name'> & { source?: SlashCommand['source'] },
): SlashCommand {
  return {
    ...identity,
    description: parsed.description,
    argumentHint: parsed.argumentHint,
    allowedTools: parsed.allowedTools,
    model: parsed.model as ClaudeModel | undefined,
    content: parsed.promptContent,
    disableModelInvocation: parsed.disableModelInvocation,
    userInvocable: parsed.userInvocable,
    context: parsed.context,
    agent: parsed.agent,
    hooks: parsed.hooks,
  };
}

export function parseSlashCommandContent(content: string): ParsedSlashCommandContent {
  const parsed = parseFrontmatter(content);

  if (!parsed) {
    return { promptContent: content };
  }

  const fm = parsed.frontmatter;

  return {
    // Existing fields — support both kebab-case (file format) and camelCase
    description: extractString(fm, 'description'),
    argumentHint: extractString(fm, 'argument-hint') ?? extractString(fm, 'argumentHint'),
    allowedTools: extractStringArray(fm, 'allowed-tools') ?? extractStringArray(fm, 'allowedTools'),
    model: extractString(fm, 'model'),
    promptContent: parsed.body,
    // Skill fields — kebab-case preferred (CC file format), camelCase for backwards compat
    disableModelInvocation:
      extractBoolean(fm, 'disable-model-invocation') ?? extractBoolean(fm, 'disableModelInvocation'),
    userInvocable:
      extractBoolean(fm, 'user-invocable') ?? extractBoolean(fm, 'userInvocable'),
    context: extractString(fm, 'context') === 'fork' ? 'fork' : undefined,
    agent: extractString(fm, 'agent'),
    hooks: isRecord(fm.hooks) ? fm.hooks : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function yamlString(value: string): string {
  if (value.includes(':') || value.includes('#') || value.includes('\n') ||
      value.startsWith(' ') || value.endsWith(' ')) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

/** Strips any frontmatter from `cmd.content` and re-serializes the command as Markdown. */
export function serializeCommand(cmd: SlashCommand): string {
  const parsed = parseSlashCommandContent(cmd.content);
  return serializeSlashCommandMarkdown(cmd, parsed.promptContent);
}

/** All frontmatter keys are serialized in kebab-case. */
export function serializeSlashCommandMarkdown(cmd: Partial<SlashCommand>, body: string): string {
  const lines: string[] = ['---'];

  if (cmd.name) {
    lines.push(`name: ${cmd.name}`);
  }
  if (cmd.description) {
    lines.push(`description: ${yamlString(cmd.description)}`);
  }
  if (cmd.argumentHint) {
    lines.push(`argument-hint: ${yamlString(cmd.argumentHint)}`);
  }
  if (cmd.allowedTools && cmd.allowedTools.length > 0) {
    lines.push('allowed-tools:');
    for (const tool of cmd.allowedTools) {
      lines.push(`  - ${tool}`);
    }
  }
  if (cmd.model) {
    lines.push(`model: ${cmd.model}`);
  }
  if (cmd.disableModelInvocation !== undefined) {
    lines.push(`disable-model-invocation: ${cmd.disableModelInvocation}`);
  }
  if (cmd.userInvocable !== undefined) {
    lines.push(`user-invocable: ${cmd.userInvocable}`);
  }
  if (cmd.context) {
    lines.push(`context: ${cmd.context}`);
  }
  if (cmd.agent) {
    lines.push(`agent: ${cmd.agent}`);
  }
  if (cmd.hooks !== undefined) {
    lines.push(`hooks: ${JSON.stringify(cmd.hooks)}`);
  }

  // Ensure at least one blank line between --- markers when no metadata exists
  // (the frontmatter regex requires \n before the closing ---)
  if (lines.length === 1) {
    lines.push('');
  }

  lines.push('---');
  lines.push(body);

  return lines.join('\n');
}
