import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { OpencodeServerService } from '../http/OpencodeServerService';
import {
  OpencodeExecutionSession,
  type OpencodeSessionKernelFactory,
} from './OpencodeExecutionSession';

export interface OpencodeExecutionBackendOptions {
  readonly serverService: OpencodeServerService;
  readonly createKernel?: OpencodeSessionKernelFactory;
}

export class OpencodeExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'opencode' as const;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: OpencodeExecutionBackendOptions,
  ) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new OpencodeExecutionSession(this.plugin, config, this.options);
  }
}
