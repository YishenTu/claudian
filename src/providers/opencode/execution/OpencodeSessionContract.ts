import type { ProviderAsyncSubagentCompletedEvent, ProviderBackgroundOutputEvent, ProviderSessionConfig, ProviderSystemInstructions } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ACPPromptRequest, ACPPromptResponse, ACPSessionConfigOption, ACPSessionModelState, ACPSessionModeState, ACPSessionNotification } from '@/providers/acp';

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
  readonly modes?: ACPSessionModeState | null;
}

export interface OpencodeSessionKernelOptions {
  readonly openNativeInteraction?: () => { turnId: string; close(): void } | undefined;
  readonly onNativeTaskStarted?: (sessionId: string, originatingTurnId: string) => string | undefined;
  readonly onNativeTaskCompleted?: (event: Omit<ProviderAsyncSubagentCompletedEvent, 'scope'>) => void;
  readonly onNativeOutput?: (event: OpencodeNativeOutput, childSessionId?: string) => void;
  readonly onNativeTurn?: (status: 'started' | 'completed', error?: string, requested?: boolean) => void;
  readonly config: ProviderSessionConfig;
  readonly databasePath?: string;
  readonly nativeVersion?: 1 | 2;
  readonly getActiveTurnId: () => string | null;
  readonly onClosed: (error: Error) => void;
  readonly onNotification: (notification: ACPSessionNotification) => void;
  readonly plugin: ProviderHost;
  readonly sessionInstanceId: string;
}

export interface OpencodeSessionKernel {
  connect(options: OpencodeKernelConnectOptions): Promise<void>;
  openSession(resumeSessionId?: string): Promise<OpencodeNativeSessionInfo>;
  setConfigOption(request: Record<string, unknown>): Promise<{
    configOptions?: ACPSessionConfigOption[] | null;
  }>;
  prompt(request: ACPPromptRequest): Promise<Pick<
    ACPPromptResponse,
    'usage' | 'userMessageId'
  > & Partial<Pick<ACPPromptResponse, 'stopReason'>>>;
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
