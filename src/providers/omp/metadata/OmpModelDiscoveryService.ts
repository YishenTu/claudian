import type { ProviderInteractionPort, ProviderSessionConfig } from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import {
  DefaultOmpAcpSessionKernel,
  type OmpAcpSessionKernel,
  type OmpAcpSessionKernelOptions,
} from '../execution/OmpAcpSessionKernel';
import {
  normalizeOmpConfigChoices,
  normalizeOmpConfigOptionModels,
  type OmpDiscoveredModel,
} from '../models';

export interface OmpModelCatalog {
  models: OmpDiscoveredModel[];
  thinking: {
    configId: string;
    currentValue: string | null;
    options: Array<{ description?: string; id: string; name: string }>;
  } | null;
}

export interface OmpModelDiscoveryServiceOptions {
  readonly createKernel?: (options: OmpAcpSessionKernelOptions) => OmpAcpSessionKernel;
}

export class OmpModelDiscoveryService {
  private readonly createKernel: (options: OmpAcpSessionKernelOptions) => OmpAcpSessionKernel;

  constructor(
    private readonly plugin: ProviderHost,
    options: OmpModelDiscoveryServiceOptions = {},
  ) {
    this.createKernel = options.createKernel
      ?? (kernelOptions => new DefaultOmpAcpSessionKernel(kernelOptions));
  }

  async discover(signal?: AbortSignal): Promise<OmpDiscoveredModel[]> {
    return (await this.discoverCatalog(signal)).models;
  }

  async discoverCatalog(signal?: AbortSignal): Promise<OmpModelCatalog> {
    signal?.throwIfAborted();
    const kernel = this.createKernel({
      config: getMetadataSessionConfig(this.plugin),
      getActiveTurnId: () => null,
      onClosed: () => undefined,
      onNotification: () => undefined,
      plugin: this.plugin,
    });
    try {
      await kernel.connect();
      signal?.throwIfAborted();
      const session = await kernel.openSession();
      signal?.throwIfAborted();
      const thinking = normalizeOmpConfigChoices(session.configOptions, 'thought_level');
      return {
        models: normalizeOmpConfigOptionModels(session.configOptions),
        thinking: thinking.configId
          ? {
            configId: thinking.configId,
            currentValue: thinking.currentValue,
            options: thinking.options,
          }
          : null,
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
