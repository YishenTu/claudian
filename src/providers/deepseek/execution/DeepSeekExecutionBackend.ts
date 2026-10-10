import type { ProviderExecutionBackend, ProviderExecutionSession, ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { DeepSeekHost } from '../runtime/DeepSeekHost';
import { DeepSeekExecutionSession } from './DeepSeekExecutionSession';

export class DeepSeekExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'deepseek';
  constructor(private readonly host: ProviderHost, private readonly deepseek: () => DeepSeekHost) {}
  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new DeepSeekExecutionSession(this.host, config, this.deepseek());
  }
}
