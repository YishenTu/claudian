import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import type { PiDiscoveredModel } from '../models';
import type { PiFamilyProfile } from '../PiFamilyProfile';
import { buildPiLaunchSpec } from './PiLaunchSpec';
import { PiRpcTransport } from './PiRpcTransport';
import { PiSubprocess } from './PiSubprocess';

export type PiModelDiscoveryResult =
  | {
    kind: 'completed';
    diagnostics?: string;
    models: PiDiscoveredModel[];
  }
  | {
    kind: 'skipped';
    reason: 'provider-disabled';
  };

export class PiModelDiscoveryService {
  constructor(
    private readonly profile: PiFamilyProfile,
    private readonly plugin: ProviderHost,
  ) {}

  async discoverModels(): Promise<PiModelDiscoveryResult> {
    const settings = this.profile.settings.get(this.plugin.settings);
    if (!settings.enabled) {
      return { kind: 'skipped', reason: 'provider-disabled' };
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const command = await this.plugin.getResolvedProviderCliPath(this.profile.providerId) ?? this.profile.defaultBinaryName;
    const envText = getRuntimeEnvironmentText(this.plugin.settings, this.profile.providerId);
    const env = {
      ...process.env,
      ...parseEnvironmentVariables(envText),
    };
    const launchSpec = buildPiLaunchSpec({
      command,
      cwd,
      env,
      envText,
      models: this.profile.models,
      noSession: true,
      settings,
    });
    const subprocess = new PiSubprocess(launchSpec, this.profile);
    let transport: PiRpcTransport | null = null;
    let removeEventListener: (() => void) | null = null;

    try {
      subprocess.start();
      transport = new PiRpcTransport({
        input: subprocess.stdout,
        onClose: (listener) => subprocess.onClose(listener),
        output: subprocess.stdin,
      });
      transport.start();
      removeEventListener = transport.onEvent((event) => {
        if (event.type !== 'extension_ui_request') {
          return;
        }

        const id = typeof event.id === 'string' && event.id.trim() ? event.id.trim() : '';
        if (id) {
          transport?.send({
            cancelled: true,
            id,
            type: 'extension_ui_response',
          });
        }
      });
      const response = await transport.request('get_available_models', {}, 20_000);
      const models = this.profile.models.normalizeDiscoveredModels(extractModels(response));
      return { kind: 'completed', models };
    } catch (error) {
      const message = error instanceof Error ? error.message : `${this.profile.displayName} model discovery failed`;
      const stderr = subprocess.getStderrSnapshot();
      return {
        diagnostics: stderr ? `${message}\n\n${stderr}` : message,
        kind: 'completed',
        models: [],
      };
    } finally {
      removeEventListener?.();
      transport?.dispose();
      await subprocess.shutdown().catch(() => {});
    }
  }
}

function extractModels(response: unknown): unknown {
  if (Array.isArray(response)) {
    return response;
  }
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    return record.models ?? record.availableModels ?? record.available_models ?? [];
  }
  return [];
}
