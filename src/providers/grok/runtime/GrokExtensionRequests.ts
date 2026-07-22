import type { AcpContentBlock, AcpJsonRpcTransport } from '../../acp';

const GROK_REWIND_TIMEOUT_MS = 120_000;

export interface GrokInterjectRequest {
  content?: AcpContentBlock[];
  interjectionId: string;
  sessionId: string;
  text: string;
}

export interface GrokForkSessionRequest {
  newCwd: string;
  newModelId?: string;
  sourceCwd: string;
  sourceSessionId: string;
  targetPromptIndex: number;
}

export interface GrokForkSessionResponse {
  newCwd: string;
  newModelId?: string;
  newSessionId: string;
  parentSessionId: string;
}

export type GrokRewindMode = 'all' | 'conversation_only' | 'files_only';

export interface GrokRewindRequest {
  force: boolean;
  mode: GrokRewindMode;
  sessionId: string;
  targetPromptIndex: number;
}

export interface GrokRewindResponse {
  cleanFiles: string[];
  conflicts: Array<{ conflictType: string; path: string }>;
  error: string | null;
  mode: GrokRewindMode;
  promptText: string | null;
  revertedFiles: string[];
  success: boolean;
  targetPromptIndex: number;
}

export async function requestGrokInterjection(
  transport: AcpJsonRpcTransport,
  request: GrokInterjectRequest,
  signal?: AbortSignal,
): Promise<void> {
  const response = await transport.request<unknown>(
    '_x.ai/interject',
    request,
    { signal },
  );
  const result = isRecord(response) ? response.result : null;
  if (
    !isRecord(response)
    || response.error !== undefined
    || !isRecord(result)
    || result.status !== 'queued'
  ) {
    throw new Error('Grok returned a malformed interjection response.');
  }
}

export async function requestGrokSessionFork(
  transport: AcpJsonRpcTransport,
  request: GrokForkSessionRequest,
): Promise<GrokForkSessionResponse> {
  const response = await transport.request<unknown>('_x.ai/session/fork', request);
  if (!isRecord(response)) {
    throw new Error('Grok returned a malformed fork response.');
  }
  const newCwd = readString(response.newCwd);
  const newSessionId = readString(response.newSessionId);
  const parentSessionId = readString(response.parentSessionId);
  const newModelId = readString(response.newModelId);
  if (!newCwd || !newSessionId || !parentSessionId) {
    throw new Error('Grok returned a malformed fork response.');
  }
  return {
    newCwd,
    ...(newModelId ? { newModelId } : {}),
    newSessionId,
    parentSessionId,
  };
}

export async function requestGrokRewind(
  transport: AcpJsonRpcTransport,
  request: GrokRewindRequest,
): Promise<GrokRewindResponse> {
  const response = await transport.request<unknown>(
    '_x.ai/rewind/execute',
    request,
    { timeoutMs: request.force ? 0 : GROK_REWIND_TIMEOUT_MS },
  );
  if (!isRecord(response)) {
    throw new Error('Grok returned a malformed rewind response.');
  }
  const targetPromptIndex = readNonNegativeInteger(
    response.target_prompt_index ?? response.targetPromptIndex,
  );
  const mode = readRewindMode(response.mode);
  if (typeof response.success !== 'boolean' || targetPromptIndex === null || !mode) {
    throw new Error('Grok returned a malformed rewind response.');
  }
  const conflicts = normalizeConflicts(response.conflicts);
  if (!conflicts) {
    throw new Error('Grok returned a malformed rewind response.');
  }
  return {
    cleanFiles: readStringArray(response.clean_files ?? response.cleanFiles) ?? [],
    conflicts,
    error: readOptionalString(response.error),
    mode,
    promptText: readOptionalString(response.prompt_text ?? response.promptText),
    revertedFiles: readStringArray(response.reverted_files ?? response.revertedFiles) ?? [],
    success: response.success,
    targetPromptIndex,
  };
}

function normalizeConflicts(
  value: unknown,
): Array<{ conflictType: string; path: string }> | null {
  const conflicts = readArray(value);
  if (!conflicts) return value === undefined ? [] : null;
  const normalized: Array<{ conflictType: string; path: string }> = [];
  for (const entry of conflicts) {
    if (!isRecord(entry)) return null;
    const conflictType = readString(entry.conflict_type ?? entry.conflictType);
    const conflictPath = readString(entry.path);
    if (!conflictType || !conflictPath) return null;
    normalized.push({ conflictType, path: conflictPath });
  }
  return normalized;
}

function readArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readRewindMode(value: unknown): GrokRewindMode | null {
  return value === 'all' || value === 'conversation_only' || value === 'files_only'
    ? value
    : null;
}

function readStringArray(value: unknown): string[] | null {
  const array = readArray(value);
  if (!array || array.some(entry => typeof entry !== 'string')) return null;
  return array as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
