import type { TodoItem } from '../../../core/tools/todo';
import type { ChatMessage, ToolCallInfo } from '../../../core/types';
import { normalizePathForComparison } from '../../../utils/path';

const DEFAULT_MAX_CHARS = 12_000;
const NARRATIVE_LIMIT = 3_000;
const APPROVAL_PATTERN = /^(?:a|ok|okay|yes|ja|resume|continue|go|mach|los|passt)[!. ]*$/i;

export interface ContinuationCapsuleInput {
  messages: readonly ChatMessage[];
  todos?: readonly TodoItem[] | null;
  maxChars?: number;
}

/** Builds a local safe handoff; provider payloads/results are intentionally unread. */
export function buildContinuationCapsule(input: ContinuationCapsuleInput): string {
  const maxChars = Math.max(1, Math.min(input.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS));
  const messages = input.messages.filter(message => !message.isRebuiltContext && !message.isInterrupt);
  const userMessages = messages.filter(message => message.role === 'user');
  const latestUser = userMessages.at(-1);
  const goal = [...userMessages].reverse().find(message => isSubstantive(canonicalText(message)));
  const latestAssistant = [...messages].reverse().find(message => (
    message.role === 'assistant' && canonicalText(message).length > 0
  ));
  const changedPaths = latestChangedPaths(messages);
  const latestInstruction = latestUser && latestUser !== goal && isTerseInstruction(canonicalText(latestUser))
    ? canonicalText(latestUser)
    : '';
  const linkedPath = latestUser?.linkedContentPath ?? goal?.linkedContentPath;
  const todos = todoLines(input.todos);
  return bounded([
    '# Continue this work in a new tab',
    goal ? `## Current goal\n${bounded(canonicalText(goal), NARRATIVE_LIMIT)}` : '',
    latestInstruction ? `## Latest instruction\n${latestInstruction}` : '',
    latestAssistant ? `## Current state\n${bounded(canonicalText(latestAssistant), NARRATIVE_LIMIT)}` : '',
    linkedPath ? `## Linked note\n${linkedPath}` : '',
    changedPaths.length ? `## Changed files\n${changedPaths.map(path => `- ${path}`).join('\n')}` : '',
    todos.length ? `## Open next steps\n${todos.map(todo => `- ${todo}`).join('\n')}` : '',
    'Continue from this handoff. Inspect files before changing them and do not assume provider-native transcript context.',
  ].filter(Boolean).join('\n\n'), maxChars);
}

/** Root selection uses raw inputs locally, but never serializes them into the capsule. */
export function selectRelevantExternalRoots(
  roots: readonly string[], messages: readonly ChatMessage[],
): string[] {
  const normalizedRoots = roots.map(root => ({
    normalized: normalizeComparisonPath(root),
    original: root,
  })).filter(root => root.normalized && isAbsolute(root.normalized));
  const absoluteEvidence = new Set<string>();
  forEachToolCall(messages, (call) => {
    collectAbsolutePaths(call.input, absoluteEvidence);
  });
  const changed = latestChangedPaths(messages)
    .map(normalizeComparisonPath)
    .filter(isAbsolute);
  return normalizedRoots.filter(root => changed.some(path => isWithin(root.normalized, path))
    || [...absoluteEvidence].some(path => isWithin(root.normalized, path)))
    .map(root => root.original);
}

export function latestChangedPaths(messages: readonly ChatMessage[]): string[] {
  const paths: string[] = []; const seen = new Set<string>();
  forEachToolCall(messages, (toolCall) => {
    const path = toolCall.diffData?.filePath?.trim();
    if (path && !seen.has(path)) { seen.add(path); paths.push(path); }
  });
  return paths;
}

function canonicalText(message: ChatMessage): string {
  return message.executionInput?.canonicalText?.trim() || message.content.trim();
}
function isSubstantive(value: string): boolean { return value.length > 0 && !APPROVAL_PATTERN.test(value); }
function isTerseInstruction(value: string): boolean { return value.length <= 80 && (APPROVAL_PATTERN.test(value) || value.length > 0); }
function todoLines(todos: readonly TodoItem[] | null | undefined): string[] {
  return (todos ?? []).filter(todo => todo.status !== 'completed').map(todo => todo.content.trim()).filter(Boolean);
}
function normalizeComparisonPath(value: string): string {
  const normalized = normalizePathForComparison(value.trim());
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}
function isAbsolute(value: string): boolean { return /^\/[\s\S]*/.test(value) || /^[a-z]:\//i.test(value); }
function isWithin(root: string, value: string): boolean { return value === root || value.startsWith(`${root}/`); }
function collectAbsolutePaths(value: unknown, paths: Set<string>, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    for (const candidate of extractPathCandidates(value)) {
      const path = normalizeComparisonPath(candidate);
      if (isAbsolute(path)) paths.add(path);
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) collectAbsolutePaths(child, paths, seen);
}

function forEachToolCall(
  messages: readonly ChatMessage[],
  visit: (toolCall: ToolCallInfo) => void,
): void {
  const seen = new Set<object>();
  const traverse = (toolCall: ToolCallInfo): void => {
    if (seen.has(toolCall)) return;
    seen.add(toolCall);
    visit(toolCall);
    for (const nested of toolCall.subagent?.toolCalls ?? []) traverse(nested);
  };
  for (const message of messages) for (const toolCall of message.toolCalls ?? []) traverse(toolCall);
}

/** Tokenizes strings without executing or retaining them; candidates are used for comparison only. */
function extractPathCandidates(value: string): string[] {
  const candidates = new Set<string>();
  const completeValue = value.trim();
  if (isAbsolute(completeValue.replace(/\\/g, '/'))) candidates.add(completeValue);
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = '';
    } else {
      token += character;
    }
  }
  if (token) tokens.push(token);

  for (const rawToken of tokens) {
    for (const rawCandidate of [rawToken, rawToken.slice(rawToken.indexOf('=') + 1)]) {
      const candidate = rawCandidate
        .replace(/^[([{]+/, '')
        .replace(/[,;:)\]}]+$/, '');
      if (isAbsolute(candidate.replace(/\\/g, '/'))) candidates.add(candidate);
    }
  }
  return [...candidates];
}
function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
