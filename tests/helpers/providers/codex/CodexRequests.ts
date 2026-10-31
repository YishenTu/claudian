import type { UserInput } from '@/providers/codex/runtime/codexAppServerTypes';

/** Required identity on thread-targeted native requests. */
export function codexThreadId(params: Record<string, unknown>): string {
  if (typeof params.threadId !== 'string') throw new Error('Invalid Codex thread identity');
  return params.threadId;
}

/** Fork fields inspected by the native peer; other launch settings remain opaque. */
export function codexForkRequest(params: Record<string, unknown>): {
  threadId: string; lastTurnId?: string; ephemeral?: boolean; excludeTurns?: boolean;
} {
  const { lastTurnId, ephemeral, excludeTurns } = params;
  if (lastTurnId !== undefined && typeof lastTurnId !== 'string') throw new Error('Invalid Codex fork checkpoint');
  if (ephemeral !== undefined && typeof ephemeral !== 'boolean') throw new Error('Invalid Codex ephemeral flag');
  if (excludeTurns !== undefined && typeof excludeTurns !== 'boolean') throw new Error('Invalid Codex excludeTurns flag');
  return { threadId: codexThreadId(params), lastTurnId, ephemeral, excludeTurns };
}

/** Reverts require the exact native turn boundary. */
export function codexRevertRequest(params: Record<string, unknown>): { threadId: string; beforeTurnId: string } {
  if (typeof params.beforeTurnId !== 'string') throw new Error('Invalid Codex revert checkpoint');
  return { threadId: codexThreadId(params), beforeTurnId: params.beforeTurnId };
}

/** Text-first turns used by chat/fork scenarios; remaining input blocks stay opaque. */
export function codexTextTurnRequest(params: Record<string, unknown>): {
  threadId: string; input: [Extract<UserInput, { type: 'text' }>, ...unknown[]];
} {
  const { input } = params;
  if (!Array.isArray(input)) throw new Error('Invalid Codex turn input');
  const first: unknown = input[0];
  if (!first || typeof first !== 'object' || !('type' in first) || first.type !== 'text'
    || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('Expected a Codex text turn');
  }
  return { threadId: codexThreadId(params), input: [{ type: 'text', text: first.text }, ...input.slice(1)] };
}
