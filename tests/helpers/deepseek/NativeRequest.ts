import type { DeepSeekAddress } from '@/providers/deepseek/history/DeepSeekJournal';
import { isRecord } from '@/providers/deepseek/remote/DeepSeekRemoteClient';

type NativeAddress = DeepSeekAddress & { sessionId?: string; childSessionId?: string };

/** Fields on the native request envelope, varying by RPC method. Responses remain unknown. */
export interface NativeRequest extends Record<string, unknown> {
  sessionId?: string;
  requestId?: string;
  agentPreset?: string;
  itemId?: string;
  attachmentId?: string;
  mode?: string;
  reasoningEffort?: string;
  atSeq?: number;
  beforeSeq?: number;
  throughSeq?: number;
  content?: unknown[];
  address?: NativeAddress;
}

function isNativeRequest(value: unknown): value is NativeRequest {
  if (!isRecord(value)) return false;
  for (const key of ['sessionId', 'requestId', 'agentPreset', 'itemId', 'attachmentId', 'mode', 'reasoningEffort']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  for (const key of ['atSeq', 'beforeSeq', 'throughSeq']) {
    if (value[key] !== undefined && typeof value[key] !== 'number') return false;
  }
  if (value.content !== undefined && !Array.isArray(value.content)) return false;
  if (value.address === undefined) return true;
  const address = value.address;
  if (!isRecord(address)) return false;
  for (const key of ['sessionId', 'childSessionId']) {
    if (address[key] !== undefined && typeof address[key] !== 'string') return false;
  }
  return (
    address.kind === 'session' ? typeof address.sessionId === 'string'
      : address.kind === 'subagent' && typeof address.childSessionId === 'string'
        && typeof address.parentSessionId === 'string' && (address.mode === 'one-shot' || address.mode === 'continuable')
  );
}

/** Narrow an observed outbound request, failing at the peer if production emits the wrong wire shape. */
export function nativeRequest(args: Record<string, unknown> | undefined): NativeRequest {
  if (!args || !isNativeRequest(args.request)) throw new Error('Invalid native request envelope');
  return args.request;
}

/** Required identity on session-targeted RPCs (session/create may deliberately omit it). */
export function nativeSessionId(args: Record<string, unknown>): string {
  const id = nativeRequest(args).sessionId;
  if (id === undefined) throw new Error('Native request omitted sessionId');
  return id;
}

/** Follow/page targets discriminate root and child sessions. */
export function nativeAddress(args: Record<string, unknown>): NativeAddress {
  const address = nativeRequest(args).address;
  if (!address) throw new Error('Native request omitted address');
  return address;
}

/** Required string fields outside the request envelope, such as commands/list's agentId. */
export function requiredNativeString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Native request omitted a required string');
  return value;
}
