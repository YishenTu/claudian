import { parseYaml, stringifyYaml } from 'obsidian';

import type { AgentSkillInput } from './AgentSkill';
import { AgentSkillValidationError, validateAgentSkillInput } from './validateAgentSkill';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/;

export interface ParsedAgentSkill {
  name: string;
  description: string;
  instructions: string;
  frontmatter: Record<string, unknown>;
}

export class AgentSkillCodecError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentSkillCodecError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseFrontmatter(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    throw new AgentSkillCodecError('SKILL.md contains invalid YAML frontmatter', { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new AgentSkillCodecError('SKILL.md frontmatter must be a YAML mapping');
  }
  return parsed;
}

export function parseAgentSkillMarkdown(content: string, directoryName: string): ParsedAgentSkill {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    throw new AgentSkillCodecError('SKILL.md must start with YAML frontmatter');
  }

  const frontmatter = parseFrontmatter(match[1]);
  if (typeof frontmatter.name !== 'string') {
    throw new AgentSkillCodecError('SKILL.md frontmatter requires a string name');
  }
  if (typeof frontmatter.description !== 'string') {
    throw new AgentSkillCodecError('SKILL.md frontmatter requires a string description');
  }
  if (frontmatter.name !== directoryName) {
    throw new AgentSkillCodecError('SKILL.md name must match its containing directory');
  }

  const parsed: ParsedAgentSkill = {
    name: frontmatter.name,
    description: frontmatter.description.trim(),
    instructions: match[2].replace(/\r\n/g, '\n').trim(),
    frontmatter,
  };
  try {
    validateAgentSkillInput(parsed);
  } catch (error) {
    if (error instanceof AgentSkillValidationError) {
      throw new AgentSkillCodecError(error.message, { cause: error });
    }
    throw error;
  }
  return parsed;
}

/**
 * Reads provider skills that do not meet the portable rules: the folder name is
 * the identity and a missing description stays empty until the user saves a
 * valid document. YAML frontmatter is still required.
 */
export function parseLenientAgentSkillMarkdown(content: string, directoryName: string): ParsedAgentSkill {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    throw new AgentSkillCodecError('SKILL.md must start with YAML frontmatter');
  }
  const frontmatter = parseFrontmatter(match[1]);
  const body = match[2];
  return {
    name: directoryName,
    description: typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '',
    instructions: body.replace(/\r\n/g, '\n').trim(),
    frontmatter,
  };
}

const OWNED_FRONTMATTER_KEYS = new Set(['name', 'description']);

export function extraFrontmatterKeys(frontmatter: Record<string, unknown>): string[] {
  return Object.keys(frontmatter).filter(key => !OWNED_FRONTMATTER_KEYS.has(key));
}

function serializeYamlFallback(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.includes('\n')) {
      lines.push(`${key}: |-`);
      lines.push(...value.split('\n').map(line => `  ${line}`));
      continue;
    }
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
  if (typeof stringifyYaml === 'function') {
    return stringifyYaml(frontmatter).trimEnd();
  }
  return serializeYamlFallback(frontmatter);
}

/** Serializes a Markdown document, omitting the frontmatter block when it has no keys. */
export function serializeMarkdownWithFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const entries = Object.entries(frontmatter).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return `${body}\n`;
  return `---\n${serializeFrontmatter(Object.fromEntries(entries))}\n---\n${body}\n`;
}

export function serializeAgentSkillMarkdown(
  currentFrontmatter: Record<string, unknown>,
  input: AgentSkillInput,
): string {
  validateAgentSkillInput(input);
  const normalized: AgentSkillInput = {
    name: input.name,
    description: input.description.trim(),
    instructions: input.instructions.trim(),
  };
  const frontmatter: Record<string, unknown> = {
    ...currentFrontmatter,
    name: normalized.name,
    description: normalized.description,
  };
  return serializeMarkdownWithFrontmatter(frontmatter, normalized.instructions);
}
