import type { AcpContentBlock, AcpJsonRpcTransport } from '../../acp';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
