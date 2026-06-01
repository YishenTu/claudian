import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type ClaudianPlugin from '../../../main';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { decodePiModelId } from '../models';
import {
  createPiEventNormalizationState,
  normalizePiRpcEvent,
} from '../normalizations/piEventNormalization';
import { getPiProviderSettings } from '../settings';
import { buildPiLaunchSpec } from './PiLaunchSpec';
import { buildPiSetModelPayload } from './PiRpcPayloads';
import { PiRpcTransport } from './PiRpcTransport';
import { PiSubprocess } from './PiSubprocess';

type PiAuxProfile = 'passive' | 'readonly';

export interface PiAuxQueryRunnerOptions {
  profile: PiAuxProfile;
}

export class PiAuxQueryRunner implements AuxQueryRunner {
  private currentLaunchKey: string | null = null;
  private process: PiSubprocess | null = null;
  private transport: PiRpcTransport | null = null;

  constructor(
    private readonly plugin: ClaudianPlugin,
    private readonly options: PiAuxQueryRunnerOptions,
  ) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    await this.ensureReady(config.systemPrompt);
    const transport = this.transport;
    if (!transport) {
      throw new Error('Pi auxiliary runtime is not ready.');
    }

    const model = this.resolveSelectedModel(config.model);
    if (model) {
      const payload = buildPiSetModelPayload(model);
      if (payload) {
        await transport.request('set_model', payload);
      }
    }

    let accumulatedText = '';
    const normalizationState = createPiEventNormalizationState();
    let terminalSettled = false;
    let resolveTerminal!: () => void;
    let rejectTerminal!: (error: Error) => void;
    const terminalPromise = new Promise<void>((resolve, reject) => {
      resolveTerminal = () => {
        if (terminalSettled) {
          return;
        }
        terminalSettled = true;
        resolve();
      };
      rejectTerminal = (error) => {
        if (terminalSettled) {
          return;
        }
        terminalSettled = true;
        reject(error);
      };
    });
    terminalPromise.catch(() => {});
    const removeListener = transport.onEvent((event) => {
      if (event.type === 'extension_ui_request') {
        const id = typeof event.id === 'string' && event.id.trim() ? event.id.trim() : '';
        if (id) {
          transport.send({
            cancelled: true,
            id,
            type: 'extension_ui_response',
          });
        }
        return;
      }

      if (event.type === 'agent_end') {
        resolveTerminal();
        return;
      }
      if (event.type === 'error') {
        rejectTerminal(new Error(
          typeof event.error === 'string' ? event.error : 'Pi auxiliary request failed',
        ));
        return;
      }
      for (const chunk of normalizePiRpcEvent(event, normalizationState)) {
        if (chunk.type === 'error') {
          rejectTerminal(new Error(chunk.content));
          continue;
        }
        if (chunk.type !== 'text') {
          continue;
        }
        accumulatedText += chunk.content;
        config.onTextChunk?.(accumulatedText);
      }
    });
    const removeCloseListener = transport.onClose((error) => {
      rejectTerminal(error ?? new Error('Pi auxiliary runtime closed before completion.'));
    });
    const abortHandler = () => {
      transport.send({ type: 'abort' });
      rejectTerminal(new Error('Cancelled'));
    };
    config.abortController?.signal.addEventListener('abort', abortHandler, { once: true });

    try {
      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }

      const promptRequest = transport.request('prompt', { message: prompt });
      promptRequest.catch(() => {});
      await Promise.race([promptRequest, terminalPromise]);
      await terminalPromise;
      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }

      return accumulatedText;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pi request failed';
      const stderr = this.process?.getStderrSnapshot();
      if (config.abortController?.signal.aborted) {
        this.reset();
      }
      throw new Error(
        stderr ? `${message}\n\n${stderr}` : message,
        error instanceof Error ? { cause: error } : undefined,
      );
    } finally {
      config.abortController?.signal.removeEventListener('abort', abortHandler);
      removeCloseListener();
      removeListener();
    }
  }

  reset(): void {
    this.currentLaunchKey = null;
    this.transport?.dispose();
    this.transport = null;
    if (this.process) {
      void this.process.shutdown().catch(() => {});
      this.process = null;
    }
  }

  private async ensureReady(systemPrompt: string): Promise<void> {
    const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
    const settings = getPiProviderSettings(settingsBag);
    const command = this.plugin.getResolvedProviderCliPath('pi') ?? 'pi';
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const envText = getRuntimeEnvironmentText(settingsBag, 'pi');
    const env = {
      ...process.env,
      ...parseEnvironmentVariables(envText),
    };
    const launchSpec = buildPiLaunchSpec({
      command,
      cwd,
      env,
      envText,
      noSession: true,
      noTools: this.options.profile === 'passive',
      settings: {
        ...settings,
        toolMode: this.options.profile === 'readonly' ? 'readonly' : settings.toolMode,
      },
      systemPrompt,
    });

    if (
      this.process
      && this.transport
      && this.process.isAlive()
      && !this.transport.isClosed
      && this.currentLaunchKey === launchSpec.launchKey
    ) {
      return;
    }

    this.reset();
    this.process = new PiSubprocess(launchSpec);
    this.process.start();
    this.transport = new PiRpcTransport({
      input: this.process.stdout,
      onClose: (listener) => this.process!.onClose(listener),
      output: this.process.stdin,
    });
    this.transport.start();
    this.currentLaunchKey = launchSpec.launchKey;
  }

  private resolveSelectedModel(explicitModel?: string): string | undefined {
    if (explicitModel && decodePiModelId(explicitModel)) {
      return explicitModel;
    }

    const projectedSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'pi',
    );
    const selectedModel = typeof projectedSettings.model === 'string'
      ? projectedSettings.model
      : '';
    return decodePiModelId(selectedModel) ? selectedModel : undefined;
  }
}
