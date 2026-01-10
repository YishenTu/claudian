/**
 * Bash Path Validator
 *
 * Pure functions for parsing bash commands and validating path access.
 * Extracted from ClaudianService for better testability and separation of concerns.
 */

import * as path from 'path';

import type { PathAccessType } from '../../utils/path';

/** Result of a path violation check */
export type PathViolation =
  | { type: 'outside_vault'; path: string }
  | { type: 'export_path_read'; path: string };

/** Context for path validation - allows dependency injection of access rules */
export interface PathCheckContext {
  getPathAccessType: (filePath: string) => PathAccessType;
}

/**
 * Split a bash command into tokens.
 * This is a best-effort tokenizer (quotes/backticks are handled; full bash parsing is out of scope).
 */
export function tokenizeBashCommand(command: string): string[] {
  const tokens: string[] = [];
  const tokenRegex = /(['"`])(.*?)\1|[^\s]+/g;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(command)) !== null) {
    const token = match[2] ?? match[0];
    const cleaned = token.trim();
    if (!cleaned) continue;
    tokens.push(cleaned);
  }

  return tokens;
}

/**
 * Split tokens into segments by common bash operators.
 * Each segment is treated as an independent command for output-target heuristics.
 */
export function splitBashTokensIntoSegments(tokens: string[]): string[][] {
  const separators = new Set(['&&', '||', ';', '|']);
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (separators.has(token)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

/** Get the command name and index from a bash segment, skipping wrappers like sudo/env */
export function getBashSegmentCommandName(segment: string[]): { cmdName: string; cmdIndex: number } {
  const wrappers = new Set(['command', 'env', 'sudo']);
  let cmdIndex = 0;
  while (cmdIndex < segment.length) {
    const token = segment[cmdIndex];
    if (wrappers.has(token)) {
      cmdIndex += 1;
      continue;
    }
    if (!token.startsWith('-') && token.includes('=')) {
      cmdIndex += 1;
      continue;
    }
    break;
  }

  const rawCmd = segment[cmdIndex] || '';
  const cmdName = path.basename(rawCmd);
  return { cmdName, cmdIndex };
}

/** Check if token is a bash output redirect operator */
export function isBashOutputRedirectOperator(token: string): boolean {
  return token === '>' || token === '>>' || token === '1>' || token === '1>>' || token === '2>' || token === '2>>' || token === '&>' || token === '&>>' || token === '>|';
}

/** Check if token is a bash input redirect operator */
export function isBashInputRedirectOperator(token: string): boolean {
  return token === '<' || token === '<<' || token === '0<' || token === '0<<';
}

/** Check if token is an output option expecting a value */
export function isBashOutputOptionExpectingValue(token: string): boolean {
  return token === '-o' || token === '--output' || token === '--out' || token === '--outfile' || token === '--output-file';
}

/** Clean a path token by stripping quotes and delimiters */
export function cleanPathToken(raw: string): string | null {
  let token = raw.trim();
  if (!token) return null;

  // Strip surrounding quotes/backticks if present.
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'")) ||
    (token.startsWith('`') && token.endsWith('`'))
  ) {
    token = token.slice(1, -1).trim();
  }

  // Trim common delimiters from shells / subshells.
  while (token.startsWith('(') || token.startsWith('[') || token.startsWith('{')) {
    token = token.slice(1).trim();
  }
  while (
    token.endsWith(')') ||
    token.endsWith(']') ||
    token.endsWith('}') ||
    token.endsWith(';') ||
    token.endsWith(',')
  ) {
    token = token.slice(0, -1).trim();
  }

  if (!token) return null;

  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'")) ||
    (token.startsWith('`') && token.endsWith('`'))
  ) {
    token = token.slice(1, -1).trim();
  }

  if (!token) return null;
  if (token === '.' || token === '/' || token === '\\' || token === '--') return null;
  return token;
}

/** Check if a token looks like a file path */
export function isPathLikeToken(token: string): boolean {
  const cleaned = token.trim();
  if (!cleaned) return false;
  if (cleaned === '.' || cleaned === '/' || cleaned === '\\' || cleaned === '--') return false;

  const isWindows = process.platform === 'win32';

  return (
    // Home directory paths (Unix and Windows style)
    cleaned === '~' ||
    cleaned.startsWith('~/') ||
    (isWindows && cleaned.startsWith('~\\')) ||
    // Relative paths
    cleaned.startsWith('./') ||
    cleaned.startsWith('../') ||
    cleaned === '..' ||
    (isWindows && (cleaned.startsWith('.\\') || cleaned.startsWith('..\\'))) ||
    // Absolute paths (Unix)
    cleaned.startsWith('/') ||
    // Absolute paths (Windows drive letters)
    (isWindows && /^[A-Za-z]:[\\/]/.test(cleaned)) ||
    // Absolute paths (Windows UNC)
    (isWindows && (cleaned.startsWith('\\\\') || cleaned.startsWith('//'))) ||
    // Contains path separators
    cleaned.includes('/') ||
    (isWindows && cleaned.includes('\\'))
  );
}

/**
 * Check if a path has valid access permissions.
 * Returns a violation if the path is outside vault and not an allowed export/context path.
 */
export function checkBashPathAccess(
  candidate: string,
  access: 'read' | 'write',
  context: PathCheckContext
): PathViolation | null {
  const cleaned = cleanPathToken(candidate);
  if (!cleaned) return null;

  const accessType = context.getPathAccessType(cleaned);

  if (accessType === 'vault' || accessType === 'readwrite') {
    return null;
  }

  if (accessType === 'context') {
    return null; // Context paths have full read/write access
  }

  if (accessType === 'export') {
    return access === 'write' ? null : { type: 'export_path_read', path: cleaned };
  }

  return { type: 'outside_vault', path: cleaned };
}

/**
 * Find path violations in a single bash command segment.
 * Analyzes redirects, output options, and positional arguments.
 */
export function findBashPathViolationInSegment(
  segment: string[],
  context: PathCheckContext
): PathViolation | null {
  if (segment.length === 0) return null;

  const { cmdName, cmdIndex } = getBashSegmentCommandName(segment);

  // Some commands have a clear destination argument that should be treated as a write target.
  const destinationCommands = new Set(['cp', 'mv', 'rsync']);
  let destinationTokenIndex: number | null = null;
  if (destinationCommands.has(cmdName)) {
    const pathArgIndices: number[] = [];
    let seenDoubleDash = false;

    for (let i = cmdIndex + 1; i < segment.length; i += 1) {
      const token = segment[i];

      if (!seenDoubleDash && token === '--') {
        seenDoubleDash = true;
        continue;
      }

      // Skip options (best-effort).
      if (!seenDoubleDash && token.startsWith('-')) {
        continue;
      }

      if (isPathLikeToken(token)) {
        pathArgIndices.push(i);
      }
    }

    if (pathArgIndices.length > 0) {
      destinationTokenIndex = pathArgIndices[pathArgIndices.length - 1];
    }
  }

  let expectWriteNext = false;

  for (let i = 0; i < segment.length; i += 1) {
    const token = segment[i];

    // Standalone redirection operators.
    if (isBashOutputRedirectOperator(token)) {
      expectWriteNext = true;
      continue;
    }
    if (isBashInputRedirectOperator(token)) {
      expectWriteNext = false;
      continue;
    }

    // Standalone output options.
    if (isBashOutputOptionExpectingValue(token)) {
      expectWriteNext = true;
      continue;
    }

    // Embedded redirection operators, e.g. ">/tmp/out", "2>>~/Desktop/log".
    const embeddedOutputRedirect = token.match(/^(?:&>>|&>|\d*>>|\d*>\||\d*>|>>|>\||>)(.+)$/);
    if (embeddedOutputRedirect) {
      const violation = checkBashPathAccess(embeddedOutputRedirect[1], 'write', context);
      if (violation) return violation;
      continue;
    }

    const embeddedInputRedirect = token.match(/^(?:\d*<<|\d*<|<<|<)(.+)$/);
    if (embeddedInputRedirect) {
      const violation = checkBashPathAccess(embeddedInputRedirect[1], 'read', context);
      if (violation) return violation;
      continue;
    }

    // Embedded output options, e.g. "--output=/tmp/out", "-o/tmp/out", "-o~/Desktop/out".
    const embeddedLongOutput = token.match(/^--(?:output|out|outfile|output-file)=(.+)$/);
    if (embeddedLongOutput) {
      const violation = checkBashPathAccess(embeddedLongOutput[1], 'write', context);
      if (violation) return violation;
      continue;
    }

    const embeddedShortOutput = token.match(/^-o(.+)$/);
    if (embeddedShortOutput) {
      const violation = checkBashPathAccess(embeddedShortOutput[1], 'write', context);
      if (violation) return violation;
      continue;
    }

    // Generic KEY=VALUE where VALUE looks like a path.
    // We treat this as a read access since it is ambiguous and can be used to smuggle paths.
    const eqIndex = token.indexOf('=');
    if (eqIndex > 0) {
      const key = token.slice(0, eqIndex);
      const value = token.slice(eqIndex + 1);
      if (key.startsWith('-') && isPathLikeToken(value)) {
        const violation = checkBashPathAccess(value, 'read', context);
        if (violation) return violation;
      }
    }

    if (!isPathLikeToken(token)) {
      expectWriteNext = false;
      continue;
    }

    const access: 'read' | 'write' =
      i === destinationTokenIndex || expectWriteNext ? 'write' : 'read';

    const violation = checkBashPathAccess(token, access, context);
    if (violation) return violation;

    expectWriteNext = false;
  }

  return null;
}

/**
 * Find the first path violation in a bash command.
 * Main entry point for bash command validation.
 *
 * @param command - The bash command to analyze
 * @param context - Path checking context with vault/export path validators
 * @returns The first violation found, or null if command is safe
 */
export function findBashCommandPathViolation(
  command: string,
  context: PathCheckContext
): PathViolation | null {
  if (!command) return null;

  const tokens = tokenizeBashCommand(command);
  const segments = splitBashTokensIntoSegments(tokens);

  for (const segment of segments) {
    const violation = findBashPathViolationInSegment(segment, context);
    if (violation) {
      return violation;
    }
  }

  return null;
}

/**
 * Extract path-like candidates from a bash command.
 * Useful for analysis/debugging.
 */
export function extractPathCandidates(command: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const token of tokenizeBashCommand(command)) {
    if (!isPathLikeToken(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    candidates.push(token);
  }

  return candidates;
}
