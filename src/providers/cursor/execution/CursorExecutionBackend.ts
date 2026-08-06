import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { DefaultCursorAcpSessionKernel} from './CursorAcpSessionKernel';
import { type CursorAcpSessionKernel } from './CursorAcpSessionKernel';
import { CursorExecutionSession } from './CursorExecutionSession';

export interface CursorExecutionBackendOptions {
  readonly createKernel?: (options: ConstructorParameters<typeof DefaultCursorAcpSessionKernel>[0]) => CursorAcpSessionKernel;
}

export class CursorExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'cursor' as const;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: CursorExecutionBackendOptions = {},
  ) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new CursorExecutionSession(this.plugin, config, this.options);
  }
}
