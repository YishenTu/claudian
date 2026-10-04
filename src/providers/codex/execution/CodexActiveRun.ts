import type { RequestedRunChannel } from '@/core/execution';

export interface TurnCompletion {
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly nativeTurnId: string;
  readonly errorMessage?: string;
  readonly durationMs?: number | null;
}

/** One requested run: the neutral stream plus the native turn it is bound to. */
export interface CodexActiveRun {
  readonly run: RequestedRunChannel;
  /** Aborts on run cancellation; abandons this run's wait for the shared app-server. */
  readonly cancellation: AbortController;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
  /** A turn start was submitted, so native work may exist without its acknowledgement. */
  nativeStartSubmitted: boolean;
  completion: TurnCompletion | null;
  /** Output tokens per native response of the bound turn; undefined when unreported. */
  readonly responseTokens: Map<string, number | undefined>;
}
