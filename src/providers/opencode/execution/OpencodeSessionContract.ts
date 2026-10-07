import type { ProviderAsyncSubagentCompletedEvent, ProviderBackgroundOutputEvent, ProviderSessionConfig, ProviderSystemInstructions } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ForkSource, SubagentProgress } from '@/core/types';
import type { ACPPromptRequest, ACPPromptResponse, ACPSessionConfigOption, ACPSessionModelState, ACPSessionNotification } from '@/providers/acp';

import type { OpencodeTextRange } from '../runtime/buildOpencodePrompt';

type WithoutScope<T> = T extends unknown ? Omit<T, 'scope'> : never;
export type OpencodeNativeOutput = WithoutScope<ProviderBackgroundOutputEvent>;

export type OpencodeExecutionProfile = 'managed' | 'passive' | 'readonly';

export interface OpencodeKernelConnectOptions {
  readonly profile: OpencodeExecutionProfile;
  readonly systemInstructions: ProviderSystemInstructions;
}

export interface OpencodeNativeSessionInfo {
  readonly sessionId: string;
  readonly nativeVersion?: 1 | 2;
  readonly databasePath: string | null;
  readonly configOptions?: ACPSessionConfigOption[] | null;
  readonly models?: ACPSessionModelState | null;
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
  readonly nativeVersion?: 1 | 2;
  readonly getActiveTurnId: () => string | null;
  readonly onClosed: (error: Error) => void;
  readonly onNotification: (notification: ACPSessionNotification) => void;
  readonly plugin: ProviderHost;
  readonly sessionInstanceId: string;
}

export interface OpencodeSessionKernel {
  readonly usesSharedRuntime?: boolean;
  readonly hasNativeWork?: boolean;
  whenIdle?(): Promise<void>;
  connect(options: OpencodeKernelConnectOptions): Promise<void>;
  openSession(resumeSessionId?: string): Promise<OpencodeNativeSessionInfo>;
  setConfigOption(request: Record<string, unknown>): Promise<{
    configOptions?: ACPSessionConfigOption[] | null;
  }>;
  /** Replies `once` to managed permission requests, like OpenCode's `--auto`; `deny` rules never ask. */
  setAutoApprove(enabled: boolean): void;
  /** `userText` locates typed input whose native mentions the kernel may resolve. */
  prompt(request: ACPPromptRequest, userText?: OpencodeTextRange | null): Promise<Pick<
    ACPPromptResponse,
    'usage' | 'userMessageId'
  > & Partial<Pick<ACPPromptResponse, 'stopReason'>>>;
  /**
   * Hands input to the running requested prompt under the neutral steer
   * contract. Absent where the native protocol cannot steer a running turn.
   */
  steer?(request: ACPPromptRequest, userText?: OpencodeTextRange | null): Promise<boolean>;
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
