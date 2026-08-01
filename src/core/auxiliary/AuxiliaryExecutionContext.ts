import type {
  ProviderExecutionBackend,
  ProviderExecutionLifecycleRegistry,
  ProviderInteractionPort,
} from '../execution';

export interface AuxiliaryExecutionContext {
  readonly backend: ProviderExecutionBackend;
  readonly interactionPort: ProviderInteractionPort;
  readonly lifecycleRegistry: ProviderExecutionLifecycleRegistry;
  readonly vaultWorkingDirectory: string;
}
