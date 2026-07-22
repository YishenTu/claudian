import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getVaultPath } from '../../../utils/path';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpMetadata,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionNotification,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  resolveAcpLoadSessionId,
} from '../../acp';
import type {
  GrokAuxiliaryLifecycleCoordinator,
  GrokAuxiliaryLifecycleOptions,
} from '../auxiliary/GrokAuxiliaryLifecycleCoordinator';
import { computeGrokEnvironmentHash } from '../env/GrokSettingsReconciler';
import { decodeGrokModelId } from '../models';
import { waitForGrokCancelDelivery } from './GrokCancelDelivery';
import { buildGrokRuntimeEnv } from './GrokRuntimeEnvironment';
import {
  GROK_EXTENSION_NOTIFICATION_METHODS,
  GROK_EXTENSION_REQUEST_METHODS,
  GrokServerRequestRouter,
} from './GrokServerRequestRouter';
import type { GrokSessionMeta } from './GrokSessionMeta';
import {
  GrokSessionNotificationMirrorDeduplicator,
  type GrokSessionNotificationSource,
} from './GrokSessionNotificationMirrorDeduplicator';
import {
  GROK_SESSION_UPDATE_NOTIFICATION_METHODS,
  GROK_WRAPPED_SESSION_NOTIFICATION_METHOD,
  parseGrokSessionNotification,
} from './GrokSessionNotifications';

const DEFAULT_QUERY_TIMEOUT_MS = 120_000;

export interface GrokAuxQueryRunnerOptions extends GrokAuxiliaryLifecycleOptions {
  timeoutMs?: number;
}

interface ActiveTurn {
  cancel: (error: Error) => void;
}

export class GrokAuxQueryRunner implements AuxQueryRunner {
  private activeSessionNotificationListener: ((notification: AcpSessionNotification) => void) | null = null;
  private activeTurn: ActiveTurn | null = null;
  private connection: AcpClientConnection | null = null;
  private connectionGeneration = 0;
  private currentLaunchKey: string | null = null;
  private currentModelId: string | null = null;
  private generation = 0;
  private lifecycle: GrokAuxiliaryLifecycleCoordinator | null;
  private readonly notificationMirrorDeduplicator = new GrokSessionNotificationMirrorDeduplicator();
  private process: AcpSubprocess | null = null;
  private requestRouter: GrokServerRequestRouter | null = null;
  private sessionAttached = false;
  private sessionId: string | null = null;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  private shutdownPromise: Promise<void> = Promise.resolve();
  private transport: AcpJsonRpcTransport | null = null;
  private readonly unregisterTransportHandlers: Array<() => void> = [];

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: GrokAuxQueryRunnerOptions = {},
  ) {
    this.lifecycle = options.lifecycle ?? null;
  }

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    if (config.abortController?.signal.aborted) {
      throw new Error('Cancelled');
    }

    const generation = this.generation;
    const signal = config.abortController?.signal;
    const lifecycle = await this.resolveLifecycle(generation, signal);
    await lifecycle?.acquire(this, signal);
    if (signal?.aborted) {
      this.releaseLifecycleAfterShutdown();
      throw new Error('Cancelled');
    }
    try {
      this.assertCurrentGeneration(generation);
    } catch (error) {
      this.releaseLifecycleAfterShutdown();
      throw error;
    }
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const explicitModelId = config.model ? decodeGrokModelId(config.model) : null;
    const sessionMeta = this.buildSessionMeta(config.systemPrompt, explicitModelId);
    const returningToNativeDefault = explicitModelId === null && this.currentModelId !== null;

    if (returningToNativeDefault) {
      this.detachAndShutdownProcess(true);
    }

    await this.ensureReady(cwd, generation);
    this.assertCurrentGeneration(generation);

    const connection = this.connection;
    if (!connection) {
      throw new Error('Grok auxiliary runtime is not ready.');
    }

    const sessionId = await this.ensureSession(connection, cwd, sessionMeta, generation);
    this.assertCurrentGeneration(generation);
    if (returningToNativeDefault) {
      this.currentModelId = null;
    }
    this.requestRouter?.setActiveSessionId(sessionId);

    const modelId = explicitModelId;
    if (modelId && modelId !== this.currentModelId) {
      await connection.setModel({ modelId, sessionId });
      this.assertCurrentGeneration(generation);
      this.currentModelId = modelId;
    }

    this.sessionUpdateNormalizer.reset();
    this.notificationMirrorDeduplicator.reset();
    let accumulatedText = '';
    const notificationListener = (notification: AcpSessionNotification): void => {
      if (notification.sessionId !== sessionId) {
        return;
      }

      let normalized: ReturnType<AcpSessionUpdateNormalizer['normalize']> | undefined;
      try {
        normalized = this.sessionUpdateNormalizer.normalize(notification.update);
      } catch {
        return;
      }
      if (!normalized || normalized.type !== 'message_chunk' || normalized.role !== 'assistant') {
        return;
      }

      for (const chunk of normalized.streamChunks) {
        if (chunk.type !== 'text') {
          continue;
        }
        accumulatedText += chunk.content;
        config.onTextChunk?.(accumulatedText);
      }
    };
    this.activeSessionNotificationListener = notificationListener;

    try {
      await this.runPrompt(connection, sessionId, prompt, config.abortController?.signal);
      this.assertCurrentGeneration(generation);
      return accumulatedText;
    } catch (error) {
      if (this.connection === connection) {
        this.detachAndShutdownProcess();
      }
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Grok auxiliary query failed.', { cause: error });
    } finally {
      if (this.activeSessionNotificationListener === notificationListener) {
        this.activeSessionNotificationListener = null;
      }
      this.notificationMirrorDeduplicator.reset();
      this.sessionUpdateNormalizer.reset();
    }
  }

  reset(): void {
    this.generation += 1;
    this.activeTurn?.cancel(new Error('Cancelled'));
    this.activeTurn = null;
    this.sessionId = null;
    this.sessionAttached = false;
    this.currentModelId = null;
    this.currentLaunchKey = null;
    this.sessionUpdateNormalizer.reset();
    this.detachAndShutdownProcess();
  }

  async cleanup(): Promise<void> {
    this.reset();
    await this.shutdownPromise;
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    this.generation += 1;
    this.activeTurn?.cancel(new Error('Cancelled'));
    this.activeTurn = null;
    this.sessionUpdateNormalizer.reset();
    this.detachAndShutdownProcess();
    await this.shutdownPromise;
  }

  private async ensureReady(cwd: string, generation: number): Promise<void> {
    await this.shutdownPromise;
    this.assertCurrentGeneration(generation);

    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const command = await this.plugin.getResolvedProviderCliPath('grok') ?? 'grok';
    this.assertCurrentGeneration(generation);
    const environmentHash = computeGrokEnvironmentHash(settings);
    const launchKey = JSON.stringify({ command, cwd, environmentHash });
    const shouldRestart = !this.process
      || !this.transport
      || !this.connection
      || !this.process.isAlive()
      || this.transport.isClosed
      || this.currentLaunchKey !== launchKey;

    if (!shouldRestart) {
      return;
    }

    this.detachAndShutdownProcess(true);
    await this.shutdownPromise;
    this.assertCurrentGeneration(generation);

    const subprocess = new AcpSubprocess({
      args: ['agent', '--no-leader', 'stdio'],
      command,
      cwd,
      env: buildGrokRuntimeEnv(settings, command),
    });
    subprocess.start();
    this.process = subprocess;

    try {
      const transport = new AcpJsonRpcTransport({
        input: subprocess.stdout,
        onClose: (listener) => subprocess.onClose(listener),
        output: subprocess.stdin,
      });
      this.transport = transport;
      const requestRouter = new GrokServerRequestRouter();
      this.requestRouter = requestRouter;
      const connectionGeneration = ++this.connectionGeneration;
      const connection = new AcpClientConnection({
        clientInfo: {
          name: 'claudian-aux',
          version: this.plugin.manifest?.version ?? '0.0.0',
        },
        delegate: {
          onSessionNotification: (notification) => {
            this.handleSessionNotification(
              notification,
              connectionGeneration,
              'standard',
            );
          },
          requestPermission: (request) => this.rejectPermissionRequest(request),
        },
        transport,
      });
      this.connection = connection;

      for (const method of GROK_SESSION_UPDATE_NOTIFICATION_METHODS) {
        this.unregisterTransportHandlers.push(transport.onNotification(method, (params) => {
          const notification = parseGrokSessionNotification(method, params);
          if (notification) {
            this.handleSessionNotification(notification, connectionGeneration, 'extension');
          }
        }));
      }
      this.unregisterTransportHandlers.push(transport.onNotification(
        GROK_WRAPPED_SESSION_NOTIFICATION_METHOD,
        (params) => {
          const notification = parseGrokSessionNotification(
            GROK_WRAPPED_SESSION_NOTIFICATION_METHOD,
            params,
          );
          if (notification) {
            this.handleSessionNotification(notification, connectionGeneration, 'extension');
          }
        },
      ));
      for (const method of GROK_EXTENSION_REQUEST_METHODS) {
        this.unregisterTransportHandlers.push(transport.onRequest(
          method,
          params => requestRouter.handleRequest(method, params),
        ));
      }
      for (const method of GROK_EXTENSION_NOTIFICATION_METHODS) {
        this.unregisterTransportHandlers.push(transport.onNotification(
          method,
          params => { requestRouter.handleNotification(method, params); },
        ));
      }

      this.currentLaunchKey = launchKey;

      transport.start();
      await connection.initialize();
      this.assertCurrentGeneration(generation);
    } catch (error) {
      this.detachAndShutdownProcess();
      throw error;
    }
  }

  private async ensureSession(
    connection: AcpClientConnection,
    cwd: string,
    sessionMeta: GrokSessionMeta & AcpMetadata,
    generation: number,
  ): Promise<string> {
    if (this.sessionId && !this.sessionAttached) {
      const retainedSessionId = this.sessionId;
      const response = await connection.loadSession({
        _meta: sessionMeta,
        cwd,
        mcpServers: [],
        sessionId: retainedSessionId,
      });
      this.assertCurrentGeneration(generation);
      const loadedSessionId = resolveAcpLoadSessionId(response, retainedSessionId);
      this.sessionId = loadedSessionId;
      this.sessionAttached = true;
      return loadedSessionId;
    }

    if (this.sessionId) {
      return this.sessionId;
    }

    const response = await connection.newSession({
      _meta: sessionMeta,
      cwd,
      mcpServers: [],
    });
    this.assertCurrentGeneration(generation);
    this.sessionId = response.sessionId;
    this.sessionAttached = true;
    this.currentModelId = null;
    return response.sessionId;
  }

  private runPrompt(
    connection: AcpClientConnection,
    sessionId: string,
    prompt: string,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let cancelling = false;
      let timer: number | null = null;

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          window.clearTimeout(timer);
        }
        externalSignal?.removeEventListener('abort', abort);
        if (this.activeTurn === activeTurn) {
          this.activeTurn = null;
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const cancel = (error: Error): void => {
        if (settled || cancelling) {
          return;
        }
        cancelling = true;
        connection.cancel({ sessionId });
        this.requestRouter?.abortPending();
        const delivery = waitForGrokCancelDelivery(this.transport);
        void delivery.then(() => finish(error));
      };
      const abort = (): void => cancel(new Error('Cancelled'));
      const activeTurn: ActiveTurn = { cancel };
      this.activeTurn = activeTurn;

      if (externalSignal?.aborted) {
        abort();
        return;
      }
      externalSignal?.addEventListener('abort', abort, { once: true });

      const timeoutMs = this.resolveTimeoutMs();
      if (timeoutMs > 0) {
        timer = window.setTimeout(() => {
          cancel(new Error(`Grok auxiliary query timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }

      const request = connection.prompt({
        prompt: [{ text: prompt, type: 'text' }],
        sessionId,
      });
      request.then(() => {
        if (!cancelling) finish();
      }, error => {
        if (cancelling) return;
        const normalizedError = error instanceof Error
          ? error
          : new Error('Grok auxiliary query failed.');
        if (/timeout/i.test(normalizedError.message)) {
          cancel(normalizedError);
          return;
        }
        finish(normalizedError);
      });
    });
  }

  private buildSessionMeta(
    systemPrompt: string,
    modelId: string | null,
  ): GrokSessionMeta & AcpMetadata {
    return {
      ...(modelId ? { modelId } : {}),
      systemPromptOverride: systemPrompt,
      yoloMode: false,
    };
  }

  private resolveTimeoutMs(): number {
    const configured = this.options.timeoutMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_QUERY_TIMEOUT_MS;
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new Error('Cancelled');
    }
  }

  private async resolveLifecycle(
    generation: number,
    signal?: AbortSignal,
  ): Promise<GrokAuxiliaryLifecycleCoordinator | null> {
    const lifecycle = this.options.resolveLifecycle
      ? await this.options.resolveLifecycle()
      : this.options.lifecycle ?? this.lifecycle;
    if (signal?.aborted) {
      throw new Error('Cancelled');
    }
    this.assertCurrentGeneration(generation);
    if (this.lifecycle && this.lifecycle !== lifecycle) {
      this.lifecycle.untrack(this);
    }
    this.lifecycle = lifecycle;
    return lifecycle;
  }

  private rejectPermissionRequest(
    request: AcpRequestPermissionRequest,
  ): Promise<AcpRequestPermissionResponse> {
    const option = request.options.find(entry => entry.kind === 'reject_once')
      ?? request.options.find(entry => entry.kind === 'reject_always');
    return Promise.resolve(option
      ? { outcome: { optionId: option.optionId, outcome: 'selected' } }
      : { outcome: { outcome: 'cancelled' } });
  }

  private handleSessionNotification(
    notification: AcpSessionNotification,
    connectionGeneration: number,
    source: GrokSessionNotificationSource,
  ): void {
    if (connectionGeneration !== this.connectionGeneration) {
      return;
    }
    if (!notification || typeof notification !== 'object'
      || !this.sessionId || notification.sessionId !== this.sessionId) {
      return;
    }
    if (!this.notificationMirrorDeduplicator.shouldProcess(notification, source)) return;
    this.activeSessionNotificationListener?.(notification);
  }

  private detachAndShutdownProcess(keepLifecycleRegistration = false): void {
    this.connectionGeneration += 1;
    this.activeSessionNotificationListener = null;
    this.notificationMirrorDeduplicator.reset();
    while (this.unregisterTransportHandlers.length > 0) {
      this.unregisterTransportHandlers.pop()?.();
    }
    this.requestRouter?.dispose();
    this.requestRouter = null;
    this.connection?.dispose();
    this.connection = null;
    this.transport?.dispose();
    this.transport = null;
    this.currentLaunchKey = null;
    this.sessionAttached = false;

    const subprocess = this.process;
    this.process = null;
    if (!subprocess) {
      if (!keepLifecycleRegistration) {
        this.releaseLifecycleAfterShutdown();
      }
      return;
    }

    const previousShutdown = this.shutdownPromise.catch(() => {});
    const currentShutdown = subprocess.shutdown().catch(() => {});
    const shutdown = Promise.all([previousShutdown, currentShutdown]).then(() => {});
    this.shutdownPromise = shutdown;
    if (!keepLifecycleRegistration) {
      this.releaseLifecycleAfterShutdown();
    }
  }

  private releaseLifecycleAfterShutdown(): void {
    const shutdown = this.shutdownPromise;
    void shutdown.then(() => {
      if (this.shutdownPromise === shutdown && !this.process) {
        this.lifecycle?.untrack(this);
      }
    });
  }
}
