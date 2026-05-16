import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type ClaudianPlugin from '../../../main';
import { getHostnameKey } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import {
  createCursorNormalizationState,
  normalizeCursorEvent,
} from '../normalization/cursorEventNormalization';
import { getCursorProviderSettings } from '../settings';
import { CursorAgentProcess } from './CursorAgentProcess';
import { resolveCursorCliPath } from './CursorBinaryLocator';
import { CursorEventTransport } from './CursorEventTransport';
import { buildCursorLaunchSpec } from './CursorLaunchSpecBuilder';

const TURN_TIMEOUT_MS = 60_000;

/**
 * Runs ephemeral `cursor-agent` invocations for auxiliary tasks (title
 * generation, instruction refinement, inline edit). Each `query()` call
 * spawns a fresh subprocess; there is no shared session state across
 * invocations.
 */
export class CursorAuxQueryRunner implements AuxQueryRunner {
  constructor(private readonly plugin: ClaudianPlugin) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    const cliPath = this.resolveCliPath();
    if (!cliPath) {
      throw new Error('Cursor agent CLI not found.');
    }

    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const envText = getRuntimeEnvironmentText(settings, 'cursor');
    const workspaceCwd = this.resolveWorkspaceCwd();
    const model = config.model ?? this.resolveModelId();

    const composedPrompt = config.systemPrompt
      ? `${config.systemPrompt}\n\n${prompt}`
      : prompt;

    const launchSpec = buildCursorLaunchSpec({
      cliPath,
      prompt: composedPrompt,
      envText,
      workspaceCwd,
      model,
    });

    const proc = new CursorAgentProcess(launchSpec);
    // Spawn first so stdout/stderr getters resolve to live streams before we
    // attach listeners or hand the readable to the transport.
    proc.start();
    const transport = new CursorEventTransport(proc.stdout);
    const state = createCursorNormalizationState();
    let accumulated = '';
    let resolveDone: (() => void) | null = null;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const finalize = (): void => {
      const cb = resolveDone;
      resolveDone = null;
      cb?.();
    };

    transport.onParseError(() => {
      // Ignore stray non-JSON lines.
    });

    const detachEvent = transport.onEvent((event) => {
      const before = state.assistantTextSoFar;
      const chunks = normalizeCursorEvent(event, state);
      if (state.assistantTextSoFar !== before) {
        accumulated = state.assistantTextSoFar;
        config.onTextChunk?.(accumulated);
      }
      for (const chunk of chunks) {
        if (chunk.type === 'done') {
          finalize();
          return;
        }
      }
    });

    const detachClose = transport.onClose(() => {
      finalize();
    });

    let stderrBuffer = '';
    proc.stderr.on('data', (data: Buffer) => {
      stderrBuffer += data.toString('utf-8');
    });

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    proc.onExit((code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finalize();
    });

    const abortHandler = (): void => {
      void proc.shutdown();
      finalize();
    };
    if (config.abortController) {
      if (config.abortController.signal.aborted) {
        throw new Error('Cancelled');
      }
      config.abortController.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const timeoutTimer = window.setTimeout(() => {
      void proc.shutdown();
      state.errorMessage = state.errorMessage ?? 'cursor-agent timed out';
      finalize();
    }, TURN_TIMEOUT_MS);

    transport.start();

    try {
      await donePromise;
    } finally {
      window.clearTimeout(timeoutTimer);
      detachEvent();
      detachClose();
      transport.dispose();
      if (proc.isAlive()) {
        await proc.shutdown();
      }
      config.abortController?.signal.removeEventListener('abort', abortHandler);
    }

    if (config.abortController?.signal.aborted) {
      throw new Error('Cancelled');
    }

    if (state.errorMessage) {
      throw new Error(state.errorMessage);
    }

    if (state.finalText !== null) {
      return state.finalText;
    }

    if (accumulated) {
      return accumulated;
    }

    if (exitCode !== null && exitCode !== 0) {
      const trimmed = stderrBuffer.trim();
      throw new Error(trimmed || `cursor-agent exited with code ${exitCode}${exitSignal ? ` (signal ${exitSignal})` : ''}`);
    }

    return '';
  }

  reset(): void {
    // One-shot semantics: nothing persistent to reset between queries.
  }

  private resolveCliPath(): string | null {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const cursorSettings = getCursorProviderSettings(settings);
    const hostnamePath = cursorSettings.cliPathsByHost[getHostnameKey()] ?? '';
    const envText = getRuntimeEnvironmentText(settings, 'cursor');
    return resolveCursorCliPath(hostnamePath, cursorSettings.cliPath, envText);
  }

  private resolveWorkspaceCwd(): string | undefined {
    try {
      return getVaultPath(this.plugin.app) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private resolveModelId(): string | undefined {
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings,
      'cursor',
    );
    const model = (providerSettings as { model?: string } | undefined)?.model;
    return typeof model === 'string' && model.trim() ? model.trim() : undefined;
  }
}
