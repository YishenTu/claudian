import type { ProviderExecutionBackend, ProviderExecutionSession, ProviderSessionConfig } from '@/core/execution';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import type { DeepSeekHost } from '../runtime/DeepSeekHost';
import { DeepSeekExecutionSession } from './DeepSeekExecutionSession';

export class DeepSeekExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'deepseek';
  constructor(private readonly host: ProviderRuntimeHost, private readonly deepseek: () => DeepSeekHost) {}
  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new DeepSeekExecutionSession(this.host, config, this.deepseek());
  }
}
