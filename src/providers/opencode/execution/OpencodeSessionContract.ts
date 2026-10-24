import type { ProviderAsyncSubagentCompletedEvent, ProviderBackgroundOutputEvent, ProviderExecutionRequest,ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ForkSource, SubagentProgress, TurnStats } from '@/core/types';

import type { OpencodeTurnSelector } from '../history/OpencodeTurnStats';
import type { OpencodeNativeModel } from '../http/OpencodeNativeModelCatalog';
import type { OpencodePrompt } from '../runtime/buildOpencodePrompt';

type WithoutScope<T> = T extends unknown ? Omit<T, 'scope'> : never;
export type OpencodeNativeOutput = WithoutScope<ProviderBackgroundOutputEvent>;

export type OpencodeExecutionProfile = 'managed' | 'passive' | 'readonly';

export interface OpencodeKernelConnectOptions {
  readonly profile: OpencodeExecutionProfile;
  /** Literal instructions, fixed for the kernel's lifetime. */
  readonly systemPrompt: string;
  /** The native session `openSession` resumes; its binding is checked before any server starts. */
  readonly resumeSessionId?: string;
}

export interface OpencodeNativeSessionInfo {
  readonly sessionId: string;
  readonly databasePath: string | null;
  /** The kernel server's enabled native model catalog. */
  readonly models: readonly OpencodeNativeModel[];
}

export interface OpencodePromptResult {
  readonly stopReason?: 'end_turn' | 'cancelled';
  readonly userMessageId?: string | null;
}

export interface OpencodeSessionKernelOptions {
  readonly onRetired?: () => void;
  /** The kernel's launch is no longer the default, so its metadata cannot be published. */
  readonly onSuperseded?: () => void;
  readonly onNativeWorkChanged?: () => void;
  readonly openNativeInteraction?: () => { turnId: string; close(): void } | undefined;
  readonly onNativeTaskStarted?: (sessionId: string, originatingTurnId: string) => string | undefined;
  readonly onNativeTaskCompleted?: (event: Omit<ProviderAsyncSubagentCompletedEvent, 'scope'>) => void;
  readonly onNativeOutput?: (event: OpencodeNativeOutput, childSessionId?: string) => void;
  readonly onNativeSubagentProgress?: (progress: SubagentProgress) => void;
  readonly onNativeTurn?: (status: 'started' | 'completed', error?: string, requested?: boolean) => void;
  readonly config: ProviderSessionConfig;
  readonly forkSource?: ForkSource;
  readonly databasePath?: string;
  readonly getActiveTurnId: () => string | null;
  readonly onClosed: (error: Error) => void;
  readonly plugin: ProviderHost;
  readonly sessionInstanceId: string;
}

export interface OpencodeSessionKernel {
  readonly hasNativeWork: boolean;
  whenIdle(): Promise<void>;
  connect(options: OpencodeKernelConnectOptions): Promise<void>;
  openSession(resumeSessionId?: string): Promise<OpencodeNativeSessionInfo>;
  /** Selects a Claudian agent profile, or a native agent ID it does not own. */
  setAgent(sessionId: string, agent: string): Promise<void>;
  /** Selects `<providerID>/<id>`; an omitted variant selects the model's native default. */
  setModel(sessionId: string, rawModelId: string, variant?: string): Promise<void>;
  /** Replies `once` to managed permission requests, like OpenCode's `--auto`; `deny` rules never ask. */
  setAutoApprove(enabled: boolean): void;
  /** The prompt's `userText` locates typed input whose native mentions the kernel may resolve. */
  prompt(sessionId: string, input: OpencodePrompt, run?: Pick<ProviderExecutionRequest, 'toolPolicy' | 'signal'>): Promise<OpencodePromptResult>;
  /** Reads a completed turn's statistics from native history, when it reports them. */
  readTurnStats(sessionId: string, turn: OpencodeTurnSelector): Promise<TurnStats | undefined>;
  /** Hands input to the running requested prompt under the neutral steer contract. */
  steer(sessionId: string, input: OpencodePrompt): Promise<boolean>;
  cancel(sessionId: string): void;
  dispose(): Promise<void>;
}

export class OpencodeSessionMissingError extends Error {
  readonly name = 'OpencodeSessionMissingError';

  constructor(
    readonly sessionId: string,
    readonly providerError: unknown,
  ) {
    super(providerError instanceof Error
      ? providerError.message
      : 'OpenCode session is missing');
  }
}
