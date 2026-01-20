/**
 * AgentStorage - Parse agent definition files.
 *
 * Agent files are markdown with YAML frontmatter, matching Claude Code's format.
 */

import { parseYaml } from 'obsidian';

import type { AgentFrontmatter } from '../types';

/**
 * Parse agent definition file content.
 *
 * Validates the following criteria:
 * - File must have YAML frontmatter between `---` markers
 * - YAML must parse as a valid object
 * - Required: `name` (non-empty string)
 * - Required: `description` (non-empty string)
 * - Optional: `tools` (string or string[] if present)
 * - Optional: `disallowedTools` (string or string[] if present)
 * - Optional: `model` (string, validated separately via parseModel)
 *
 * @param content - Raw markdown file content
 * @returns Parsed frontmatter and body, or null if validation fails
 */
export function parseAgentFile(content: string): { frontmatter: AgentFrontmatter; body: string } | null {
  // Extract YAML frontmatter between --- markers
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  try {
    const parsed = parseYaml(match[1]);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const frontmatter = parsed as AgentFrontmatter;
    const body = match[2].trim();

    // Validate required fields
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

/**
 * Parse tools specification into array.
 *
 * Supports multiple YAML formats:
 * - undefined/empty → undefined (inherit all tools)
 * - "Read, Grep" → ['Read', 'Grep'] (comma-separated string)
 * - [] → [] (explicit no tools)
 * - ['Read', 'Grep'] → ['Read', 'Grep'] (YAML array)
 *
 * @param tools - Tools specification from YAML frontmatter
 * @returns Array of tool names, empty array for explicit none, or undefined to inherit
 */
export function parseToolsList(tools?: string | string[]): string[] | undefined {
  // undefined → inherit all tools
  if (tools === undefined) return undefined;

  // Already an array (YAML array syntax)
  if (Array.isArray(tools)) {
    // Empty array [] means explicit "no tools"
    // Non-empty array is used as-is
    return tools.map(t => String(t).trim()).filter(Boolean);
  }

  // String: empty → inherit, non-empty → parse comma-separated
  if (typeof tools === 'string') {
    const trimmed = tools.trim();
    if (!trimmed) return undefined;
    return trimmed.split(',').map(t => t.trim()).filter(Boolean);
  }

  // Unknown type, inherit all
  return undefined;
}

/** Valid model values for agent definitions. */
const VALID_MODELS = ['sonnet', 'opus', 'haiku', 'inherit'] as const;

/**
 * Parse and validate model specification.
 *
 * @param model - Model value from YAML frontmatter
 * @returns Validated model value, or 'inherit' for invalid/missing values
 */
export function parseModel(model?: string): 'sonnet' | 'opus' | 'haiku' | 'inherit' {
  if (!model) return 'inherit';
  const normalized = model.toLowerCase().trim();
  if (VALID_MODELS.includes(normalized as typeof VALID_MODELS[number])) {
    return normalized as 'sonnet' | 'opus' | 'haiku' | 'inherit';
  }
  // Invalid model value, fall back to inherit
  return 'inherit';
}
