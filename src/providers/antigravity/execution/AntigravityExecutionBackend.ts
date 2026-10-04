import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import { AntigravityExecutionSession } from './AntigravityExecutionSession';

export class AntigravityExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'antigravity' as const;

  constructor(private readonly plugin: ProviderHost) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new AntigravityExecutionSession(this.plugin, config);
  }
}
