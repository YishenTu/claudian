import type { ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type {
  ACPPromptRequest,
  ACPPromptResponse,
  ACPSessionConfigOption,
  ACPSessionModelState,
  ACPSessionNotification,
} from '@/providers/acp';

export interface AntigravityNativeSessionInfo {
  readonly sessionId: string;
  readonly configOptions?: ACPSessionConfigOption[] | null;
  readonly models?: ACPSessionModelState | null;
  readonly currentModeId?: string;
}

export interface AntigravitySessionKernelOptions {
  readonly config: ProviderSessionConfig;
  readonly getActiveTurnId: () => string | null;
  readonly onClosed: (error: Error) => void;
  readonly onNotification: (notification: ACPSessionNotification) => void;
  readonly plugin: ProviderHost;
  readonly sessionInstanceId: string;
}

export interface AntigravitySessionKernel {
  connect(): Promise<void>;
  openSession(resumeSessionId?: string): Promise<AntigravityNativeSessionInfo>;
  setConfigOption(configId: string, value: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  prompt(request: ACPPromptRequest): Promise<Pick<
    ACPPromptResponse,
    'usage' | 'userMessageId'
  > & Partial<Pick<ACPPromptResponse, 'stopReason'>>>;
  cancel(sessionId: string): void;
  dispose(): Promise<void>;
}
