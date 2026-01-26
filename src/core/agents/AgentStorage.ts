/**
 * AgentStorage - Parse agent definition files.
 *
 * Agent files are markdown with YAML frontmatter, matching Claude Code's format.
 */

import { parseYaml } from 'obsidian';

import type { AgentFrontmatter } from '../types';

export function parseAgentFile(content: string): { frontmatter: AgentFrontmatter; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  try {
    const parsed = parseYaml(match[1]);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const frontmatter = parsed as AgentFrontmatter;
    const body = match[2].trim();

    if (typeof frontmatter.name !== 'string' || !frontmatter.name.trim()) {
      return null;
    }
    if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
      return null;
    }

    // Validate tools fields to avoid unexpected privilege inheritance
    if (frontmatter.tools !== undefined && !isStringOrArray(frontmatter.tools)) {
      return null;
    }
    if (frontmatter.disallowedTools !== undefined && !isStringOrArray(frontmatter.disallowedTools)) {
      return null;
    }

    return { frontmatter, body };
  } catch {
    return null;
  }
}

function isStringOrArray(value: unknown): value is string | string[] {
  return typeof value === 'string' || Array.isArray(value);
}

/** Parse tools specification into array. Returns undefined to inherit all tools. */
export function parseToolsList(tools?: string | string[]): string[] | undefined {
  if (tools === undefined) return undefined;

  if (Array.isArray(tools)) {
    return tools.map(t => String(t).trim()).filter(Boolean);
  }

  if (typeof tools === 'string') {
    const trimmed = tools.trim();
    if (!trimmed) return undefined;
    return trimmed.split(',').map(t => t.trim()).filter(Boolean);
  }

  return undefined;
}

const VALID_MODELS = ['sonnet', 'opus', 'haiku', 'inherit'] as const;

/** Parse and validate model specification. Falls back to 'inherit'. */
export function parseModel(model?: string): 'sonnet' | 'opus' | 'haiku' | 'inherit' {
  if (!model) return 'inherit';
  const normalized = model.toLowerCase().trim();
  if (VALID_MODELS.includes(normalized as typeof VALID_MODELS[number])) {
    return normalized as 'sonnet' | 'opus' | 'haiku' | 'inherit';
  }
  return 'inherit';
}
