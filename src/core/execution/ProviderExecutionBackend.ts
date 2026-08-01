import type { ProviderId } from '../types/provider';
import type { ProviderExecutionSession } from './ProviderExecutionSession';
import type { ProviderInteractionPort } from './ProviderInteractionPort';

export type ProviderSessionLifecycle = 'persistent' | 'ephemeral';

export type ProviderNativePersistence =
  | 'enabled'
  | 'disabled-if-supported'
  | 'provider-default';

export interface ProviderNativeResumeSeed {
  readonly providerSessionId?: string;
  readonly providerState?: Readonly<Record<string, unknown>>;
  readonly resumeCheckpoint?: string;
}

export interface ProviderSessionConfig {
  readonly lifecycle: ProviderSessionLifecycle;
  readonly nativePersistence: ProviderNativePersistence;
  readonly resumeSeed?: ProviderNativeResumeSeed;
  readonly vaultWorkingDirectory: string;
  readonly interactionPort: ProviderInteractionPort;
}

/**
 * Cheap provider registration entry point. Active native lifecycle belongs to
 * the independently created session, never to the backend object. Neither this
 * configuration nor the backend receives a Claudian conversation identity.
 * The resume seed is fixed for the lifetime of the created session.
 */
export interface ProviderExecutionBackend {
  readonly providerId: ProviderId;
  createSession(config: ProviderSessionConfig): ProviderExecutionSession;
}
