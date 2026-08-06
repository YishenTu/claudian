import type { ProviderInteractionPort, ProviderSessionConfig } from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import {
  type CursorAcpSessionKernel,
  type CursorAcpSessionKernelOptions,
  DefaultCursorAcpSessionKernel,
} from '../execution/CursorAcpSessionKernel';
import {
  type CursorDiscoveredModel,
  normalizeCursorDiscoveredModels,
} from '../models';

export interface CursorModelCatalog {
  models: CursorDiscoveredModel[];
}

export interface CursorModelDiscoveryServiceOptions {
  readonly createKernel?: (options: CursorAcpSessionKernelOptions) => CursorAcpSessionKernel;
}

export class CursorModelDiscoveryService {
  private readonly createKernel: (options: CursorAcpSessionKernelOptions) => CursorAcpSessionKernel;

  constructor(
    private readonly plugin: ProviderHost,
    options: CursorModelDiscoveryServiceOptions = {},
  ) {
    this.createKernel = options.createKernel
      ?? (kernelOptions => new DefaultCursorAcpSessionKernel(kernelOptions));
  }

  async discover(signal?: AbortSignal): Promise<CursorDiscoveredModel[]> {
    return (await this.discoverCatalog(signal)).models;
  }

  async discoverCatalog(signal?: AbortSignal): Promise<CursorModelCatalog> {
    signal?.throwIfAborted();
    const kernel = this.createKernel({
      config: getMetadataSessionConfig(this.plugin),
      getActiveTurnId: () => null,
      onClosed: () => undefined,
      onNotification: () => undefined,
      plugin: this.plugin,
      sessionInstanceId: 'cursor-metadata',
    });
    try {
      await kernel.connect();
      signal?.throwIfAborted();
      const session = await kernel.openSession();
      signal?.throwIfAborted();
      return {
        models: normalizeCursorDiscoveredModels(session.models?.availableModels),
      };
    } finally {
      await kernel.dispose();
    }
  }

}

function getMetadataSessionConfig(plugin: ProviderHost): ProviderSessionConfig {
  const adapter = plugin.app.vault.adapter as { basePath?: unknown };
  return {
    interactionPort: DENY_INTERACTION_PORT,
    lifecycle: 'ephemeral',
    nativePersistence: 'disabled-if-supported',
    vaultWorkingDirectory: typeof adapter.basePath === 'string' && adapter.basePath
      ? adapter.basePath
      : process.cwd(),
  };
}

const DENY_INTERACTION_PORT: ProviderInteractionPort = {
  askUserQuestion: async ({ interactionId }) => ({ answers: null, interactionId }),
  dismissInteraction: () => undefined,
  requestApproval: async ({ interactionId }) => ({ decision: 'deny', interactionId }),
  requestPlanDecision: async ({ interactionId }) => ({ decision: null, interactionId }),
};
