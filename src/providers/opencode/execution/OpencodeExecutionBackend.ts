import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import type { OpencodeServerService } from '../http/OpencodeServerService';
import {
  type OpencodeACPSessionKernelFactory,
  OpencodeExecutionSession,
} from './OpencodeExecutionSession';

export interface OpencodeExecutionBackendOptions {
  readonly serverService: OpencodeServerService;
  readonly createKernel?: OpencodeACPSessionKernelFactory;
}

export class OpencodeExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'opencode' as const;

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly options: OpencodeExecutionBackendOptions,
  ) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new OpencodeExecutionSession(this.host, config, this.options);
  }
}
