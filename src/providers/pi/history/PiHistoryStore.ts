import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { isWriteEditTool } from '../../../core/tools/toolNames';
import type { ChatMessage, ContentBlock, ToolCallInfo } from '../../../core/types';
import { extractDiffData } from '../../../utils/diff';
import {
  extractPiToolTextContent,
  normalizePiToolInput,
  normalizePiToolName,
} from '../normalizations/piToolNormalization';

export interface PiSessionEntry {
  id?: string;
  message?: Record<string, unknown>;
  parentId?: string;
  raw: Record<string, unknown>;
  type: string;
}

export interface ParsedPiSessionEntries {
  entries: PiSessionEntry[];
  header: Record<string, unknown> | null;
}

export interface ParsePiSessionContentOptions {
  leafEntryId?: string;
  requireLeafEntryId?: boolean;
}

export interface CreatePiForkSessionFileOptions {
  now?: Date;
  sessionDir?: string;
  sessionId?: string;
  targetCwd?: string;
}

export interface CreatedPiForkSessionFile {
  leafEntryId: string;
  parentSession: string;
  sessionFile: string;
  sessionId: string;
}

export function parsePiSessionContent(
  content: string,
  options: ParsePiSessionContentOptions = {},
): ChatMessage[] {
  const parsed = parsePiSessionEntries(content);
  const leafEntryId = options.leafEntryId?.trim();
  if (
    options.requireLeafEntryId
    && (!leafEntryId || !parsed.entries.some(entry => entry.id === leafEntryId))
  ) {
    return [];
  }

  return mapPiSessionEntries(resolvePiActivePath(
    parsed.entries,
    leafEntryId,
  ));
}

export function parsePiSessionEntries(content: string): ParsedPiSessionEntries {
  const entries: PiSessionEntry[] = [];
  let header: Record<string, unknown> | null = null;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isPlainObject(parsed)) {
        continue;
      }
      record = parsed;
    } catch {
      continue;
    }

    const type = getString(record.type) ?? getString(record.kind) ?? '';
    if (type === 'session') {
      header = record;
      continue;
    }

    const message = getRecord(record.message) ?? getRecord(record.data) ?? inferMessageRecord(record);
    entries.push({
      ...(getString(record.id) ? { id: getString(record.id)! } : {}),
      ...(message ? { message } : {}),
      ...(getString(record.parentId) ?? getString(record.parent_id)
        ? { parentId: (getString(record.parentId) ?? getString(record.parent_id))! }
        : {}),
      raw: record,
      type,
    });
  }

  return { entries, header };
}

export function resolvePiActivePath(entries: PiSessionEntry[], leafId?: string): PiSessionEntry[] {
  const entriesWithIds = entries.filter((entry): entry is PiSessionEntry & { id: string } => !!entry.id);
  if (entriesWithIds.length === 0) {
    return entries;
  }

  const hasBranchGraph = hasPiBranchGraph(entriesWithIds);
  if (!leafId && !hasBranchGraph) {
    return entries;
  }

  const byId = new Map(entriesWithIds.map(entry => [entry.id, entry] as const));
  const targetLeafId = leafId && byId.has(leafId)
    ? leafId
    : entriesWithIds[entriesWithIds.length - 1]?.id;
  if (!targetLeafId) {
    return entries;
  }

  const activePath = hasBranchGraph
    ? resolvePiGraphEntryPath(byId, targetLeafId)
    : resolvePiLinearEntryPath(entries, targetLeafId);
  if (activePath.length === 0) {
    return entries;
  }

  return hasBranchGraph
    ? includePiGraphPathEntries(entries, activePath)
    : includePiLinearPathEntries(entries, activePath);
}

export function resolvePiEntryPath(entries: PiSessionEntry[], leafId: string): PiSessionEntry[] {
  const entriesWithIds = entries.filter((entry): entry is PiSessionEntry & { id: string } => !!entry.id);
  const byId = new Map(entriesWithIds.map(entry => [entry.id, entry] as const));
  if (!byId.has(leafId)) {
    return [];
  }

  const hasBranchGraph = hasPiBranchGraph(entriesWithIds);
  const activePath = hasBranchGraph
    ? resolvePiGraphEntryPath(byId, leafId)
    : resolvePiLinearEntryPath(entries, leafId);
  if (activePath.length === 0) {
    return [];
  }

  return hasBranchGraph
    ? includePiGraphPathEntries(entries, activePath)
    : includePiLinearPathEntries(entries, activePath);
}

function hasPiBranchGraph(entriesWithIds: PiSessionEntry[]): boolean {
  return entriesWithIds.some(entry => !!entry.parentId && !isToolResultEntry(entry));
}

function resolvePiGraphEntryPath(
  byId: Map<string, PiSessionEntry>,
  targetLeafId: string,
): PiSessionEntry[] {
  const activePath: PiSessionEntry[] = [];
  const seen = new Set<string>();
  let current: PiSessionEntry | undefined = byId.get(targetLeafId);
  while (current) {
    if (!current.id || seen.has(current.id)) {
      break;
    }
    seen.add(current.id);
    activePath.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return activePath;
}

function resolvePiLinearEntryPath(entries: PiSessionEntry[], targetLeafId: string): PiSessionEntry[] {
  const leafIndex = entries.findIndex(entry => entry.id === targetLeafId);
  if (leafIndex < 0) {
    return [];
  }
  return entries.slice(0, leafIndex + 1);
}

function includePiGraphPathEntries(
  entries: PiSessionEntry[],
  activePath: PiSessionEntry[],
): PiSessionEntry[] {
  const activeIds = new Set(activePath.map(entry => entry.id).filter((id): id is string => !!id));
  const activeToolCallIds = collectToolCallIds(activePath);
  return entries.filter((entry) => {
    if (isToolResultEntry(entry)) {
      const toolCallId = getToolResultCallId(entry);
      return (!!toolCallId && activeToolCallIds.has(toolCallId))
        || (!!entry.id && activeIds.has(entry.id))
        || (!!entry.parentId && activeIds.has(entry.parentId));
    }
    if (entry.id) {
      return activeIds.has(entry.id);
    }
    if (entry.parentId && activeIds.has(entry.parentId)) {
      return true;
    }
    return false;
  });
}

function includePiLinearPathEntries(
  entries: PiSessionEntry[],
  activePath: PiSessionEntry[],
): PiSessionEntry[] {
  const activeEntries = new Set(activePath);
  const activeToolCallIds = collectToolCallIds(activePath);
  return entries.filter((entry) => {
    if (activeEntries.has(entry)) {
      return true;
    }
    if (!isToolResultEntry(entry)) {
      return false;
    }
    const toolCallId = getToolResultCallId(entry);
    return !!toolCallId && activeToolCallIds.has(toolCallId);
  });
}

export async function createPiForkSessionFile(
  sourceSessionFile: string,
  resumeAt: string,
  options: CreatePiForkSessionFileOptions = {},
): Promise<CreatedPiForkSessionFile> {
  const sourceContent = await fsp.readFile(sourceSessionFile, 'utf-8');
  const parsed = parsePiSessionEntries(sourceContent);
  const branchEntries = resolvePiEntryPath(parsed.entries, resumeAt);
  if (branchEntries.length === 0) {
    throw new Error(`Pi fork checkpoint not found: ${resumeAt}`);
  }

  const timestamp = options.now ?? new Date();
  const timestampText = timestamp.toISOString();
  const sessionId = options.sessionId ?? randomUUID();
  const sessionDir = options.sessionDir ?? path.dirname(sourceSessionFile);
  const sessionFile = path.join(
    sessionDir,
    `${timestampText.replace(/[:.]/g, '-')}_${sessionId}.jsonl`,
  );
  const sourceCwd = typeof parsed.header?.cwd === 'string' && parsed.header.cwd.trim()
    ? parsed.header.cwd.trim()
    : process.cwd();
  const header = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: timestampText,
    cwd: options.targetCwd ?? sourceCwd,
    parentSession: sourceSessionFile,
  };
  const lines = [
    JSON.stringify(header),
    ...branchEntries.map(entry => JSON.stringify(entry.raw)),
  ];

  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.writeFile(sessionFile, `${lines.join('\n')}\n`, { flag: 'wx' });

  return {
    leafEntryId: resumeAt,
    parentSession: sourceSessionFile,
    sessionFile,
    sessionId,
  };
}

export function findPiSessionFile(
  sessionIdOrFile: string,
  cwd?: string | null,
  sessionDir?: string | null,
): string | null {
  const trimmed = sessionIdOrFile.trim();
  if (!trimmed) {
    return null;
  }

  if (path.isAbsolute(trimmed) && fileExists(trimmed)) {
    return trimmed;
  }

  const roots = [
    sessionDir,
    cwd ? path.join(cwd, '.pi', 'agent', 'sessions') : null,
    path.join(os.homedir(), '.pi', 'agent', 'sessions'),
  ].filter((root): root is string => !!root);

  for (const root of roots) {
    const direct = path.join(root, trimmed.endsWith('.jsonl') ? trimmed : `${trimmed}.jsonl`);
    if (fileExists(direct)) {
      return direct;
    }

    const found = findSessionFileInRoot(root, trimmed);
    if (found) {
      return found;
    }
  }

  return null;
}

export function derivePiSessionsRootFromSessionPath(sessionPath: string): string | null {
  const normalized = sessionPath.trim();
  if (!normalized) {
    return null;
  }

  return path.dirname(normalized);
}

function mapPiSessionEntries(entries: PiSessionEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const entry of entries) {
    const mapped = mapPiSessionEntry(entry, messages);
    if (mapped) {
      const previous = messages[messages.length - 1];
      if (isAssistantMessageEntry(entry) && canMergeAssistantContinuation(previous, mapped)) {
        mergeAssistantContinuation(previous, mapped);
      } else {
        messages.push(mapped);
      }
    }
  }

  return messages;
}

function isAssistantMessageEntry(entry: PiSessionEntry): boolean {
  const message = entry.message ?? entry.raw;
  return (getString(message.role) ?? inferRole(entry.type)) === 'assistant';
}

function isBoundaryMessage(message: ChatMessage): boolean {
  return message.contentBlocks?.some(block => block.type === 'context_compacted') === true;
}

function canMergeAssistantContinuation(
  previous: ChatMessage | undefined,
  next: ChatMessage,
): previous is ChatMessage {
  return previous?.role === 'assistant'
    && next.role === 'assistant'
    && !isBoundaryMessage(previous)
    && !isBoundaryMessage(next);
}

function mergeAssistantContinuation(target: ChatMessage, source: ChatMessage): void {
  target.content += source.content;
  target.assistantMessageId = source.assistantMessageId ?? target.assistantMessageId;

  if (source.contentBlocks && source.contentBlocks.length > 0) {
    target.contentBlocks = [
      ...(target.contentBlocks ?? []),
      ...source.contentBlocks,
    ];
  }

  if (source.toolCalls && source.toolCalls.length > 0) {
    const existingToolIds = new Set(target.toolCalls?.map(toolCall => toolCall.id) ?? []);
    const newToolCalls = source.toolCalls.filter(toolCall => !existingToolIds.has(toolCall.id));
    if (newToolCalls.length > 0) {
      target.toolCalls = [
        ...(target.toolCalls ?? []),
        ...newToolCalls,
      ];
    }
  }
}

function mapPiSessionEntry(
  entry: PiSessionEntry,
  messages: ChatMessage[],
): ChatMessage | null {
  const message = entry.message ?? entry.raw;
  const role = getString(message.role) ?? inferRole(entry.type);
  const timestamp = getTimestamp(message.timestamp ?? entry.raw.timestamp);

  if (role === 'user') {
    return {
      content: extractTextContent(message.content ?? message.text ?? message.message),
      id: entry.id ?? `pi-user-${messages.length}`,
      role: 'user',
      timestamp,
      userMessageId: entry.id,
    };
  }

  if (role === 'assistant') {
    const contentBlocks = extractAssistantContentBlocks(message.content ?? message.parts ?? message.blocks);
    const toolCalls = extractAssistantToolCalls(message.content ?? message.parts ?? message.blocks);
    const text = contentBlocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.content)
      .join('');

    return {
      assistantMessageId: entry.id,
      content: text,
      ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
      id: entry.id ?? `pi-assistant-${messages.length}`,
      role: 'assistant',
      timestamp,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  if (isToolResultEntry(entry)) {
    applyToolResult(messages, entry);
    return null;
  }

  if (entry.type === 'compaction') {
    return {
      content: '',
      contentBlocks: [{ type: 'context_compacted' }],
      id: entry.id ?? `pi-compaction-${messages.length}`,
      role: 'assistant',
      timestamp,
    };
  }

  if (
    (entry.type === 'branch_summary' || entry.type === 'compactionSummary' || entry.type === 'custom_message')
    && entry.raw.display !== false
  ) {
    const content = extractTextContent(entry.raw.content ?? entry.raw.summary ?? entry.raw.message);
    if (!content) {
      return null;
    }
    return {
      content,
      contentBlocks: [{ type: 'text', content }],
      id: entry.id ?? `pi-notice-${messages.length}`,
      role: 'assistant',
      timestamp,
    };
  }

  return null;
}

function extractAssistantContentBlocks(value: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const parts = Array.isArray(value) ? value : [{ type: 'text', text: extractTextContent(value) }];

  for (const part of parts) {
    if (!isPlainObject(part)) {
      continue;
    }

    const type = getString(part.type);
    if (type === 'thinking' || type === 'reasoning') {
      const content = extractTextContent(part.thinking ?? part.text ?? part.content);
      if (content) {
        blocks.push({ type: 'thinking', content });
      }
      continue;
    }

    if (type === 'toolCall' || type === 'tool_call' || type === 'toolUse' || type === 'tool_use') {
      const toolId = getString(part.id) ?? getString(part.toolCallId) ?? getString(part.callId);
      if (toolId) {
        blocks.push({ type: 'tool_use', toolId });
      }
      continue;
    }

    const content = extractTextContent(part.text ?? part.content);
    if (content) {
      blocks.push({ type: 'text', content });
    }
  }

  return blocks;
}

function extractAssistantToolCalls(value: unknown): ToolCallInfo[] {
  const parts = Array.isArray(value) ? value : [];
  return parts.flatMap((part): ToolCallInfo[] => {
    if (!isPlainObject(part)) {
      return [];
    }

    const type = getString(part.type);
    if (type !== 'toolCall' && type !== 'tool_call' && type !== 'toolUse' && type !== 'tool_use') {
      return [];
    }

    const id = getString(part.id) ?? getString(part.toolCallId) ?? getString(part.callId);
    const rawName = getString(part.name) ?? getString(part.tool) ?? getString(part.toolName);
    if (!id || !rawName) {
      return [];
    }
    const name = normalizePiToolName(rawName);

    return [{
      id,
      input: normalizePiToolInput(part.input ?? part.arguments ?? part.args, name),
      name,
      status: 'running',
    }];
  });
}

function collectToolCallIds(entries: PiSessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const message = entry.message ?? entry.raw;
    const parts = message.content ?? message.parts ?? message.blocks;
    for (const toolCall of extractAssistantToolCalls(parts)) {
      ids.add(toolCall.id);
    }
  }
  return ids;
}

function isToolResultEntry(entry: PiSessionEntry): boolean {
  const message = entry.message ?? entry.raw;
  return entry.type === 'toolResult'
    || entry.type === 'tool_result'
    || getString(message.role) === 'toolResult'
    || getString(message.role) === 'tool_result';
}

function getToolResultCallId(entry: PiSessionEntry): string | null {
  const message = entry.message ?? entry.raw;
  return getString(message.toolCallId)
    ?? getString(message.tool_call_id)
    ?? getString(message.id)
    ?? getString(entry.raw.toolCallId)
    ?? getString(entry.raw.tool_call_id)
    ?? getString(entry.raw.id);
}

function applyToolResult(messages: ChatMessage[], entry: PiSessionEntry): void {
  const toolCallId = getToolResultCallId(entry);
  if (!toolCallId) {
    return;
  }

  for (let index = messages.length - 1; index >= 0; index--) {
    const chatMessage = messages[index];
    const toolCall = chatMessage.toolCalls?.find(call => call.id === toolCallId);
    if (!toolCall) {
      continue;
    }

    const resultMessage = entry.message ?? entry.raw;
    toolCall.status = resultMessage.error === true || resultMessage.isError === true ? 'error' : 'completed';
    toolCall.result = extractPiToolTextContent(resultMessage.result ?? resultMessage.content ?? resultMessage.output);
    if (toolCall.status === 'completed' && isWriteEditTool(toolCall.name)) {
      const diffData = extractDiffData(resultMessage, toolCall);
      if (diffData) {
        toolCall.diffData = diffData;
      }
    }
    return;
  }
}

function inferMessageRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return getString(record.role) ? record : undefined;
}

function inferRole(type: string): string | null {
  if (type === 'user' || type === 'assistant') {
    return type;
  }
  return null;
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractTextContent).filter(Boolean).join('');
  }

  if (!isPlainObject(value)) {
    return '';
  }

  if (typeof value.text === 'string') {
    return value.text;
  }

  if (typeof value.content === 'string') {
    return value.content;
  }

  return '';
}

function findSessionFileInRoot(root: string, sessionId: string): string | null {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = findSessionFileInRoot(candidate, sessionId);
        if (nested) {
          return nested;
        }
      } else if (
        entry.isFile()
        && entry.name.endsWith('.jsonl')
        && entry.name.includes(sessionId)
      ) {
        return candidate;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
