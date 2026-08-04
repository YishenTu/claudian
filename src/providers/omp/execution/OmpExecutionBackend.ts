import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { DefaultOmpAcpSessionKernel} from './OmpAcpSessionKernel';
import { type OmpAcpSessionKernel } from './OmpAcpSessionKernel';
import { OmpExecutionSession } from './OmpExecutionSession';

export interface OmpExecutionBackendOptions {
  readonly createKernel?: (options: ConstructorParameters<typeof DefaultOmpAcpSessionKernel>[0]) => OmpAcpSessionKernel;
}

export class OmpExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'omp' as const;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: OmpExecutionBackendOptions = {},
  ) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new OmpExecutionSession(this.plugin, config, this.options);
  }
}
