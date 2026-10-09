export const DEEPSEEK_PRESETS = ['claudian', 'claudian-code', 'claudian-passive', 'claudian-read-only'] as const;
export type DeepSeekPreset = typeof DEEPSEEK_PRESETS[number];

export function isDeepSeekPreset(value: unknown): value is DeepSeekPreset {
  return DEEPSEEK_PRESETS.includes(value as DeepSeekPreset);
}

export interface DeepSeekProviderState {
  readonly schemaVersion: 1;
  readonly home: string;
  readonly profile: 'web';
  readonly preset: DeepSeekPreset;
  readonly checkpointSeq?: number;
  readonly pendingFork?: { readonly sessionId: string; readonly atSeq: number };
}

/** Decode only owned durable facts. Never copy prompts, credentials or attachment bytes. */
export function decodeDeepSeekState(value: unknown): DeepSeekProviderState | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid DeepSeek session state.');
  const state = value as Record<string, unknown>;
  if (Object.keys(state).length === 0) return undefined;
  if (state.schemaVersion !== 1) throw new Error('Unsupported DeepSeek session state version.');
  if (typeof state.home !== 'string' || !state.home.trim() || state.profile !== 'web') {
    throw new Error('Invalid DeepSeek native store binding.');
  }
  if (!isDeepSeekPreset(state.preset)) throw new Error('Invalid DeepSeek saved preset.');
  const checkpointSeq = state.checkpointSeq;
  if (checkpointSeq !== undefined && !isCheckpoint(checkpointSeq)) throw new Error('Invalid DeepSeek checkpoint.');
  let pendingFork: DeepSeekProviderState['pendingFork'];
  if (state.pendingFork !== undefined) {
    const fork = state.pendingFork as Record<string, unknown> | null;
    if (!fork || typeof fork.sessionId !== 'string' || !fork.sessionId.trim() || !isCheckpoint(fork.atSeq)) {
      throw new Error('Invalid DeepSeek fork checkpoint.');
    }
    pendingFork = { sessionId: fork.sessionId, atSeq: fork.atSeq };
  }
  return {
    schemaVersion: 1, home: state.home, profile: 'web', preset: state.preset,
    ...(checkpointSeq !== undefined ? { checkpointSeq: checkpointSeq } : {}),
    ...(pendingFork ? { pendingFork } : {}),
  };
}

export function bindDeepSeekState(
  saved: unknown,
  defaults: { home: string; codeMode: boolean; preset?: DeepSeekPreset },
): DeepSeekProviderState {
  return decodeDeepSeekState(saved) ?? {
    schemaVersion: 1, home: defaults.home, profile: 'web',
    preset: defaults.preset ?? (defaults.codeMode ? 'claudian-code' : 'claudian'),
  };
}

export function isCheckpoint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function encodeDeepSeekCheckpoint(sequence: number): string {
  if (!isCheckpoint(sequence)) throw new Error('Invalid DeepSeek checkpoint.');
  return `deepseek:seq:${sequence}`;
}

export function decodeDeepSeekCheckpoint(value: string): number {
  const match = /^deepseek:seq:(0|[1-9]\d*)$/.exec(value);
  const sequence = match ? Number(match[1]) : NaN;
  if (!isCheckpoint(sequence)) throw new Error('Invalid DeepSeek checkpoint.');
  return sequence;
}
