import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { PiFamilyWorkspaceServices } from '../app/PiWorkspaceServices';
import {
  createPiForkSessionFile,
  rollbackCreatedPiForkSessionFile,
} from '../history/PiHistoryStore';
import type { PiFamilyProfile } from '../PiFamilyProfile';
import type { PiExtensionUiRenderer } from '../runtime/PiExtensionUiBridge';
import {
  createPiExecutionKernel,
  type PiExecutionKernelFactory,
} from './PiExecutionKernel';
import { PiExecutionSession } from './PiExecutionSession';

type PiExecutionServices = Pick<PiFamilyWorkspaceServices, 'commandCatalog'>;

export interface PiExecutionBackendOptions {
  readonly createForkSessionFile?: typeof createPiForkSessionFile;
  readonly createKernel?: PiExecutionKernelFactory;
  readonly extensionUiRenderer?: PiExtensionUiRenderer | null;
  readonly rollbackForkSessionFile?: typeof rollbackCreatedPiForkSessionFile;
}

export class PiExecutionBackend implements ProviderExecutionBackend {
  readonly providerId: string;

  constructor(
    private readonly profile: PiFamilyProfile,
    private readonly host: ProviderHost,
    private readonly services: PiExecutionServices,
    private readonly options: PiExecutionBackendOptions = {},
  ) {
    this.providerId = profile.providerId;
  }

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new PiExecutionSession(
      this.profile,
      this.host,
      this.services,
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
