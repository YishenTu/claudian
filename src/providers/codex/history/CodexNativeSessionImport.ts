import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { SessionMetadata } from '../../../core/types';
import { deriveCodexSessionsRootFromSessionPath } from './CodexHistoryStore';

interface CodexSessionScanRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface CodexNativeSessionCandidate {
  cwd: string;
  createdAt: number;
  lastResponseAt?: number;
  sessionFilePath: string;
  threadId: string;
  title: string;
  updatedAt: number;
}

export interface CodexNativeSessionImportResult {
  imported: SessionMetadata[];
  skippedDuplicate: number;
  skippedOtherWorkspace: number;
  scanned: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(line: string): CodexSessionScanRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;
    return {
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
      type: typeof parsed.type === 'string' ? parsed.type : undefined,
      payload: isRecord(parsed.payload) ? parsed.payload : undefined,
    };
  } catch {
    return null;
  }
}

function toMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function normalizeComparablePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

function isWithinOrEqualPath(candidatePath: string, parentPath: string): boolean {
  const candidate = normalizeComparablePath(candidatePath);
  const parent = normalizeComparablePath(parentPath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (typeof item.text === 'string') {
      parts.push(item.text);
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

function cleanTitle(text: string): string | null {
  const trimmedText = text.trim();
  if (
    trimmedText.startsWith('<environment_context>')
    || trimmedText.startsWith('# AGENTS.md instructions')
    || trimmedText.startsWith('<INSTRUCTIONS>')
    || trimmedText.startsWith('<system-reminder>')
  ) {
    return null;
  }

  const normalized = text
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const requestIndex = normalized.findIndex(line => /my request for codex/i.test(line));
  const titleSource = requestIndex >= 0
    ? normalized.slice(requestIndex + 1).find(Boolean)
    : normalized.find(line => (
      !line.startsWith('<')
      && !line.startsWith('# AGENTS.md')
      && !line.startsWith('## Open tabs:')
      && !line.startsWith('## Active file:')
    ));

  const title = titleSource ?? text.trim();
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function extractUserTitle(record: CodexSessionScanRecord): string | null {
  const payload = record.payload;
  if (!payload) return null;

  if (record.type === 'event_msg' && payload.type === 'user_message') {
    const message = typeof payload.message === 'string' ? payload.message : null;
    return message ? cleanTitle(message) : null;
  }

  if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    const text = extractTextContent(payload.content);
    return text ? cleanTitle(text) : null;
  }

  return null;
}

function extractThreadIdFromFilePath(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  const match = base.match(/([A-Za-z0-9][A-Za-z0-9_-]*)$/);
  return match?.[1] ?? base.replace(/[^A-Za-z0-9_-]/g, '_');
}

function scanSessionFile(filePath: string): CodexNativeSessionCandidate | null {
  let content: string;
  let stat: fs.Stats;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  let cwd: string | null = null;
  let title: string | null = null;
  let threadId: string | null = null;
  let createdAt: number | null = null;
  let updatedAt = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Date.now();

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (!record) continue;

    const timestamp = toMillis(record.timestamp);
    if (timestamp != null) {
      createdAt = createdAt == null ? timestamp : Math.min(createdAt, timestamp);
      updatedAt = Math.max(updatedAt, timestamp);
    }

    const payload = record.payload;
    if (!payload) continue;

    if (record.type === 'session_meta') {
      if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd;
      if (!threadId && typeof payload.id === 'string') threadId = payload.id;
      const payloadTimestamp = toMillis(payload.timestamp);
      if (payloadTimestamp != null) {
        createdAt = createdAt == null ? payloadTimestamp : Math.min(createdAt, payloadTimestamp);
      }
    }

    if (record.type === 'turn_context' && !cwd && typeof payload.cwd === 'string') {
      cwd = payload.cwd;
    }

    if (!title) {
      title = extractUserTitle(record);
    }
  }

  if (!cwd) return null;

  const resolvedThreadId = threadId ?? extractThreadIdFromFilePath(filePath);
  const resolvedCreatedAt = createdAt ?? stat.birthtimeMs ?? stat.mtimeMs ?? Date.now();
  return {
    cwd,
    createdAt: resolvedCreatedAt,
    updatedAt,
    lastResponseAt: updatedAt,
    sessionFilePath: filePath,
    threadId: resolvedThreadId,
    title: title || 'Codex session',
  };
}

function collectJsonlFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function buildDuplicateSets(existing: SessionMetadata[]): {
  ids: Set<string>;
  paths: Set<string>;
  threadIds: Set<string>;
} {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const threadIds = new Set<string>();

  for (const meta of existing) {
    ids.add(meta.id);
    if (meta.sessionId) threadIds.add(meta.sessionId);
    const state = isRecord(meta.providerState) ? meta.providerState : {};
    if (typeof state.threadId === 'string') threadIds.add(state.threadId);
    if (typeof state.sessionFilePath === 'string') {
      paths.add(normalizeComparablePath(state.sessionFilePath));
    }
  }

  return { ids, paths, threadIds };
}

function toSessionMetadata(candidate: CodexNativeSessionCandidate): SessionMetadata {
  const transcriptRootPath = deriveCodexSessionsRootFromSessionPath(candidate.sessionFilePath) ?? undefined;
  return {
    id: `codex-${candidate.threadId}`,
    providerId: 'codex',
    title: candidate.title,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    lastResponseAt: candidate.lastResponseAt,
    sessionId: candidate.threadId,
    providerState: {
      threadId: candidate.threadId,
      sessionFilePath: candidate.sessionFilePath,
      ...(transcriptRootPath ? { transcriptRootPath } : {}),
    },
  };
}

export function importCodexNativeSessionsForVault(params: {
  existingMetadata: SessionMetadata[];
  sessionsRoot?: string;
  vaultPath: string;
}): CodexNativeSessionImportResult {
  const sessionsRoot = params.sessionsRoot ?? path.join(os.homedir(), '.codex', 'sessions');
  const result: CodexNativeSessionImportResult = {
    imported: [],
    skippedDuplicate: 0,
    skippedOtherWorkspace: 0,
    scanned: 0,
  };

  if (!fs.existsSync(sessionsRoot)) {
    return result;
  }

  const duplicates = buildDuplicateSets(params.existingMetadata);

  for (const filePath of collectJsonlFiles(sessionsRoot)) {
    result.scanned += 1;
    const candidate = scanSessionFile(filePath);
    if (!candidate || !isWithinOrEqualPath(candidate.cwd, params.vaultPath)) {
      result.skippedOtherWorkspace += 1;
      continue;
    }

    const meta = toSessionMetadata(candidate);
    const normalizedSessionPath = normalizeComparablePath(candidate.sessionFilePath);
    if (
      duplicates.ids.has(meta.id)
      || duplicates.threadIds.has(candidate.threadId)
      || duplicates.paths.has(normalizedSessionPath)
    ) {
      result.skippedDuplicate += 1;
      continue;
    }

    duplicates.ids.add(meta.id);
    duplicates.threadIds.add(candidate.threadId);
    duplicates.paths.add(normalizedSessionPath);
    result.imported.push(meta);
  }

  return result;
}
