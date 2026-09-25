import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import type { OpencodeServerService } from '../http/OpencodeServerService';
import {
  type OpencodeACPSessionKernelFactory,
  OpencodeExecutionSession,
} from './OpencodeExecutionSession';

export interface OpencodeExecutionBackendOptions {
  readonly commandCatalog?: Pick<OpencodeCommandCatalog, 'setCommandSnapshot'>;
  readonly serverService: OpencodeServerService;
  readonly createKernel?: OpencodeACPSessionKernelFactory;
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
