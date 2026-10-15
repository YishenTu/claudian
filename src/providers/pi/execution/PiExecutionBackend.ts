import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import {
  createPiForkSessionFile,
  rollbackCreatedPiForkSessionFile,
} from '../history/PiHistoryStore';
import type { PiExtensionUIRenderer } from '../runtime/PiExtensionUIBridge';
import {
  createPiExecutionKernel,
  type PiExecutionKernelFactory,
} from './PiExecutionKernel';
import { PiExecutionSession } from './PiExecutionSession';

export interface PiExecutionBackendOptions {
  readonly createForkSessionFile?: typeof createPiForkSessionFile;
  readonly createKernel?: PiExecutionKernelFactory;
  readonly extensionUiRenderer?: PiExtensionUIRenderer | null;
  readonly rollbackForkSessionFile?: typeof rollbackCreatedPiForkSessionFile;
}

export class PiExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'pi' as const;

  constructor(
    private readonly host: ProviderHost,
    private readonly options: PiExecutionBackendOptions = {},
  ) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new PiExecutionSession(
      this.host,
      config,
      {
        createForkSessionFile: this.options.createForkSessionFile
          ?? createPiForkSessionFile,
        createKernel: this.options.createKernel ?? createPiExecutionKernel,
        extensionUiRenderer: this.options.extensionUiRenderer ?? null,
        rollbackForkSessionFile: this.options.rollbackForkSessionFile
          ?? rollbackCreatedPiForkSessionFile,
      },
    );
  }
}
