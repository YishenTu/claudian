import { randomUUID } from 'node:crypto';

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderExecutionRun,
  ProviderExecutionSession,
  ProviderRequestedEventScope,
  ProviderSessionConfig,
  ProviderSessionEvent,
  ProviderSessionSnapshot,
  ProviderSessionStatus,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { UsageInfo } from '@/core/types';
import {
  type AcpContentBlock,
  AcpExecutionEventNormalizer,
  type AcpSessionNotification,
  type AcpUsage,
  type AcpUsageUpdate,
  buildAcpUsageInfo,
} from '@/providers/acp';
import { appendCurrentNote } from '@/utils/context';
import { appendEditorContext } from '@/utils/editor';

import { decodeCursorModelId } from '../models';
import { getCursorProviderSettings } from '../settings';
import {
  type CursorAcpSessionKernel,
  type CursorAcpSessionKernelOptions,
  DefaultCursorAcpSessionKernel,
} from './CursorAcpSessionKernel';

class EventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private closed = false;
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];

  constructor(private readonly onReturn: () => void) {}

  [Symbol.asyncIterator](): AsyncIterator<T> { return this; }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<T>> {
    if (!this.closed) this.onReturn();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
}

class CursorExecutionRun implements ProviderExecutionRun {
  readonly executionId = randomUUID();
  readonly turnId = randomUUID();
  readonly queue: EventQueue<ProviderExecutionEvent>;
  readonly events: AsyncIterable<ProviderExecutionEvent>;
  terminal = false;
  private sequence = 0;

  constructor(private readonly cancelRun: () => void) {
    this.queue = new EventQueue(() => this.cancel());
    this.events = this.queue;
  }

  cancel(): void { if (!this.terminal) this.cancelRun(); }

  scope(): ProviderRequestedEventScope {
    return {
      executionId: this.executionId,
      kind: 'requested',
      sequence: ++this.sequence,
      sessionInstanceId: this.sessionInstanceId,
      turnId: this.turnId,
    };
  }

  get sessionInstanceId(): string { return this._sessionInstanceId; }
  setSessionInstanceId(value: string): void { this._sessionInstanceId = value; }
  finish(event: ProviderExecutionEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.queue.push(event);
    this.queue.close();
  }

  private _sessionInstanceId = '';
}

export interface CursorExecutionSessionOptions {
  readonly createKernel?: (options: CursorAcpSessionKernelOptions) => CursorAcpSessionKernel;
}

export class CursorExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'cursor' as const;
  readonly sessionInstanceId = randomUUID();
  private readonly createKernel: (options: CursorAcpSessionKernelOptions) => CursorAcpSessionKernel;
  private readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  private kernel: CursorAcpSessionKernel | null = null;
  private nativeSessionId: string | null;
  private activeRun: CursorExecutionRun | null = null;
  private snapshot: ProviderSessionSnapshot;
  private lastUsage: UsageInfo | null = null;
  private disposed = false;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
    options: CursorExecutionSessionOptions = {},
  ) {
    this.createKernel = options.createKernel ?? (kernelOptions => new DefaultCursorAcpSessionKernel(kernelOptions));
    this.nativeSessionId = config.resumeSeed?.providerSessionId ?? null;
    this.snapshot = this.makeSnapshot('idle');
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('Cursor execution session is disposed');
    if (this.activeRun) throw new Error('Cursor execution session already has an active run');
    const run = new CursorExecutionRun(() => this.cancelRun(run));
    run.setSessionInstanceId(this.sessionInstanceId);
    this.activeRun = run;
    void this.startRun(run, request);
    return run;
  }

  cancel(): void { this.activeRun?.cancel(); }

  getSnapshot(): ProviderSessionSnapshot { return this.snapshot; }
  getStatus(): ProviderSessionStatus { return this.snapshot.status; }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.activeRun?.finish({ reason: 'session-disposed', scope: this.activeRun.scope(), type: 'cancelled' });
    this.activeRun = null;
    this.snapshot = this.makeSnapshot('disposed');
    await this.kernel?.dispose();
    this.kernel = null;
    this.listeners.clear();
  }

  private async startRun(run: CursorExecutionRun, request: ProviderExecutionRequest): Promise<void> {
    try {
      if (!this.kernel) {
        this.kernel = this.createKernel({
          config: this.config,
          getActiveTurnId: () => this.activeRun?.turnId ?? null,
          onClosed: error => {
            const activeRun = this.activeRun;
            if (activeRun) this.failRun(activeRun, error);
          },
          onNotification: notification => {
            const activeRun = this.activeRun;
            if (activeRun) this.handleNotification(activeRun, notification);
          },
          plugin: this.plugin,
          sessionInstanceId: this.sessionInstanceId,
        });
        await this.kernel.connect();
      }
      const native = await this.kernel.openSession(this.nativeSessionId ?? undefined);
      this.nativeSessionId = native.sessionId;
      await this.applyConfiguration(native, request);
      this.snapshot = this.makeSnapshot('executing');
      this.emitSnapshot(run);
      const normalizer = new AcpExecutionEventNormalizer({
        mapUsage: usage => buildCursorUsageInfo(
          usage,
          decodeCursorModelId(request.configuration.model ?? '') ?? undefined,
        ),
        scope: {
          executionId: run.executionId,
          kind: 'requested',
          sessionInstanceId: this.sessionInstanceId,
          turnId: run.turnId,
        },
      });
      this.normalizers.set(run, normalizer);
      const selectedModel = decodeCursorModelId(request.configuration.model ?? '')
        ?? getCursorProviderSettings(this.plugin.settings).visibleModels[0]
        ?? undefined;
      if (!this.lastUsage) {
        const initialUsage = buildInitialCursorUsageInfo(selectedModel);
        this.lastUsage = initialUsage;
        run.queue.push({
          scope: run.scope(),
          type: 'usage_updated',
          usage: initialUsage,
        });
      }
      const response = await this.kernel.prompt({
        prompt: buildCursorPrompt(request),
        sessionId: native.sessionId,
      });
      if (run.terminal) return;
      if (response.usage) {
        const usage = buildCursorPromptUsageInfo(
          response.usage,
          decodeCursorModelId(request.configuration.model ?? '') ?? undefined,
          this.lastUsage?.contextWindow,
        );
        if (usage) {
          this.lastUsage = usage;
          run.queue.push({ scope: run.scope(), type: 'usage_updated', usage });
        }
      }
      run.queue.push({ accepted: true, nativeUserMessageId: response.userMessageId ?? undefined, scope: run.scope(), type: 'turn_started' });
      this.snapshot = this.makeSnapshot('idle');
      this.emitSnapshot(run);
      run.finish({ reason: 'completed', scope: run.scope(), type: 'turn_completed' });
      this.activeRun = null;
    } catch (error) {
      this.failRun(run, error);
    }
  }

  private readonly normalizers = new WeakMap<CursorExecutionRun, AcpExecutionEventNormalizer>();

  private async applyConfiguration(
    native: Awaited<ReturnType<CursorAcpSessionKernel['openSession']>>,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    if (!this.kernel) return;
    const modelId = request.configuration.model
      ? decodeCursorModelId(request.configuration.model)
      : null;
    if (modelId) await this.kernel.setModel({ modelId, sessionId: native.sessionId });

    const modeId = request.configuration.permissionMode === 'plan'
      ? 'plan'
      : request.configuration.permissionMode === 'ask'
        ? 'ask'
        : 'agent';
    await this.kernel.setMode({ modeId, sessionId: native.sessionId });

  }

  private handleNotification(run: CursorExecutionRun, notification: AcpSessionNotification): void {
    if (run.terminal || notification.sessionId !== this.nativeSessionId) return;
    const result = this.normalizers.get(run)?.normalize(notification.update);
    for (const event of result?.events ?? []) {
      if (event.type === 'usage_updated') {
        this.lastUsage = event.usage;
      }
      run.queue.push({ ...event, scope: run.scope() });
    }
  }

  private cancelRun(run: CursorExecutionRun): void {
    if (this.activeRun !== run || run.terminal) return;
    if (this.nativeSessionId) this.kernel?.cancel(this.nativeSessionId);
    run.finish({ reason: 'cancelled', scope: run.scope(), type: 'cancelled' });
    this.activeRun = null;
  }

  private failRun(run: CursorExecutionRun, error: unknown): void {
    if (run.terminal) return;
    const message = error instanceof Error ? error.message : String(error);
    this.snapshot = {
      ...this.makeSnapshot('invalidated'),
      invalidation: { message, reason: 'provider-error', recoverable: true },
      status: 'invalidated',
    };
    run.finish({ category: 'provider', message, recoverable: true, scope: run.scope(), type: 'execution_error' });
    this.activeRun = null;
  }

  private emitSnapshot(run: CursorExecutionRun): void {
    run.queue.push({ scope: run.scope(), snapshot: this.snapshot, type: 'session_state_changed' });
  }

  private makeSnapshot(status: ProviderSessionStatus): ProviderSessionSnapshot {
    const base = {
      providerId: this.providerId,
      providerSessionId: this.nativeSessionId ?? undefined,
      revision: Date.now(),
    };
    if (status === 'invalidated') {
      return { ...base, invalidation: { reason: 'provider-error', recoverable: true }, status };
    }
    return { ...base, status };
  }
}

export function buildCursorPrompt(request: ProviderExecutionRequest): AcpContentBlock[] {
  let text = request.input.filter(block => block.type === 'text').map(block => block.text).join('\n');
  if (request.context?.currentNote?.path) {
    text = appendCurrentNote(text, request.context.currentNote.path);
  }
  if (request.context?.editorSelection) {
    text = appendEditorContext(text, request.context.editorSelection);
  }
  const blocks: AcpContentBlock[] = [{ type: 'text', text }];
  for (const block of request.input) {
    if (block.type === 'image' && block.image.data) {
      blocks.push({ type: 'image', data: block.image.data, mimeType: block.image.mediaType });
    }
  }
  return blocks;
}

export function buildCursorUsageInfo(usage: AcpUsageUpdate, model?: string) {
  return buildAcpUsageInfo({
    contextWindow: usage,
    model,
    promptUsage: null,
  });
}

export function buildCursorPromptUsageInfo(
  usage: AcpUsage,
  model?: string,
  fallbackContextWindow = 200_000,
): UsageInfo | null {
  return buildAcpUsageInfo({
    fallbackContextWindow,
    model,
    promptUsage: usage,
  });
}

export function buildInitialCursorUsageInfo(model?: string): UsageInfo {
  return {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextTokens: 0,
    contextWindow: 200_000,
    contextWindowIsAuthoritative: false,
    inputTokens: 0,
    ...(model ? { model } : {}),
    percentage: 0,
  };
}
