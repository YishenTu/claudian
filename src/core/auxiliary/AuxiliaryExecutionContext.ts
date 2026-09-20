import type {
  ProviderExecutionBackend,
  ProviderExecutionLifecycleRegistry,
  ProviderInteractionPort,
  ProviderNativePersistence,
} from '../execution';

export interface AuxiliaryExecutionContext {
  readonly nativePersistence: ProviderNativePersistence;
  readonly backend: ProviderExecutionBackend;
  readonly interactionPort: ProviderInteractionPort;
  readonly lifecycleRegistry: ProviderExecutionLifecycleRegistry;
  readonly vaultWorkingDirectory: string;
}
