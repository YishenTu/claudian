/**
 * Claudian - Slash command utilities
 *
 * Core parsing logic for slash command YAML frontmatter.
 * Delegates to Obsidian's parseYaml() via parseFrontmatter().
 */

import {
  extractBoolean,
  extractString,
  extractStringArray,
  parseFrontmatter,
} from './frontmatter';

/** Parsed slash command frontmatter and prompt content. */
export interface ParsedSlashCommandContent {
  description?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  promptContent: string;
  // Skill fields
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  context?: string;
  agent?: string;
  hooks?: unknown;
}

/**
 * Parses YAML frontmatter from command content.
 * Returns parsed metadata and the remaining prompt content.
 */
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
    // Skill fields
    disableModelInvocation: extractBoolean(fm, 'disableModelInvocation'),
    userInvocable: extractBoolean(fm, 'userInvocable'),
    context: extractString(fm, 'context'),
    agent: extractString(fm, 'agent'),
    hooks: fm.hooks,
  };
}
