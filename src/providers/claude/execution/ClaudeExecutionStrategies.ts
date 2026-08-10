import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { loadClaudeAgentQuery } from '../loadClaudeAgentSdk';
import { runColdStartQuery } from '../runtime/claudeColdStartQuery';
import { MessageChannel } from '../runtime/ClaudeMessageChannel';
import { buildClaudeSDKUserMessage } from '../runtime/ClaudeUserMessageFactory';
import type { ClaudeEncodedExecutionRequest } from './ClaudeExecutionRequestEncoder';

export interface ClaudeExecutionStrategySink {
  readonly sessionInstanceId: string;
  getProviderSessionId(): string | null;
  setPendingNativeUserMessageId(
    nativeUserMessageId: string,
    queryToken: number,
  ): void;
  markNativeTurnHandedOff(queryToken: number): void;
  handleNativeMessage(message: SDKMessage, queryToken: number): Promise<void>;
  handleNativeFailure(error: unknown, queryToken: number): void;
  handleNativeEnd(queryToken: number): void;
  releaseNativeTurnFence(queryToken: number): void;
  publishCommands(query: Query, queryToken: number): void;
}

export interface ClaudeExecutionStrategy {
  startTurn(
    request: ClaudeEncodedExecutionRequest,
    queryToken: number,
  ): Promise<void>;
  cancel(queryToken: number | null, nativeTurnHandedOff: boolean): void;
  setMode(mode: Parameters<Query['setPermissionMode']>[0]): Promise<boolean>;
  getRewindQuery(): Query | null;
  ensureReadyForRewind(
    request: ClaudeEncodedExecutionRequest,
    queryToken: number,
  ): Promise<Query | null>;
  dispose(): Promise<void>;
}

type PersistentNativeTurnOutcome =
  | { readonly type: 'completed' }
  | { readonly type: 'failed'; readonly error: unknown };

interface PersistentNativeTurn {
  readonly query: Query;
  readonly queryToken: number;
  readonly completion: Promise<PersistentNativeTurnOutcome>;
  settle(outcome: PersistentNativeTurnOutcome): void;
}

export class ClaudePersistentExecutionStrategy
implements ClaudeExecutionStrategy {
  private query: Query | null = null;
  private messageChannel: MessageChannel | null = null;
  private abortController: AbortController | null = null;
  private consumerPromise: Promise<void> | null = null;
  private currentConfig: ClaudeEncodedExecutionRequest | null = null;
  private activeNativeTurn: PersistentNativeTurn | null = null;
  private preparingTurnToken: number | null = null;
  private disposed = false;

  constructor(private readonly sink: ClaudeExecutionStrategySink) {}

  async startTurn(
    request: ClaudeEncodedExecutionRequest,
    queryToken: number,
  ): Promise<void> {
    const requestSignal = request.options.abortController?.signal;
    const priorTurn = this.activeNativeTurn;
    if (priorTurn) {
      const outcome = await priorTurn.completion;
      requestSignal?.throwIfAborted();
      if (outcome.type === 'failed') {
        throw outcome.error;
      }
    }

    requestSignal?.throwIfAborted();
    this.preparingTurnToken = queryToken;
    try {
      await this.ensureQuery(request, queryToken);
      requestSignal?.throwIfAborted();
      if (!this.query || !this.messageChannel) {
        throw new Error('Claude persistent query is unavailable');
      }

      await this.applyDynamicUpdates(request);
      requestSignal?.throwIfAborted();
      const message = buildClaudeSDKUserMessage(
        request.prompt,
        this.sink.getProviderSessionId() ?? '',
        request.images,
      );
      if (message.uuid) {
        this.sink.setPendingNativeUserMessageId(message.uuid, queryToken);
      }
      requestSignal?.throwIfAborted();
      const query = this.query;
      this.messageChannel.enqueue(message);
      this.activeNativeTurn = createPersistentNativeTurn(query, queryToken);
      this.sink.markNativeTurnHandedOff(queryToken);
    } finally {
      if (this.preparingTurnToken === queryToken) {
        this.preparingTurnToken = null;
      }
    }
  }

  cancel(
    queryToken: number | null,
    nativeTurnHandedOff: boolean,
  ): void {
    if (
      !nativeTurnHandedOff
      && queryToken !== null
      && this.preparingTurnToken === queryToken
    ) {
      void this.closeCurrentQuery().catch(() => undefined);
      return;
    }
    if (
      nativeTurnHandedOff
      && (
        queryToken === null
        || this.activeNativeTurn?.queryToken === queryToken
      )
    ) {
      void this.query?.interrupt().catch(() => undefined);
    }
  }

  async setMode(
    mode: Parameters<Query['setPermissionMode']>[0],
  ): Promise<boolean> {
    if (!this.query) return false;
    await this.query.setPermissionMode(mode);
    return true;
  }

  getRewindQuery(): Query | null {
    return this.query;
  }

  async ensureReadyForRewind(
    request: ClaudeEncodedExecutionRequest,
    queryToken: number,
  ): Promise<Query | null> {
    await this.ensureQuery(request, queryToken);
    return this.query;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const query = this.query;
    this.messageChannel?.close();
    this.abortController?.abort();
    this.query = null;
    this.messageChannel = null;
    this.abortController = null;
    if (query) {
      this.finishNativeTurn(query, {
        type: 'failed',
        error: new Error('Claude persistent query was disposed.'),
      });
      await query.interrupt().catch(() => undefined);
    }
    await this.consumerPromise?.catch(() => undefined);
    this.consumerPromise = null;
    this.currentConfig = null;
  }

  private async ensureQuery(
    request: ClaudeEncodedExecutionRequest,
    queryToken: number,
  ): Promise<void> {
    const requestSignal = request.options.abortController?.signal;
    requestSignal?.throwIfAborted();
    if (this.disposed) {
      throw new Error('Claude persistent strategy is disposed');
    }
    if (
      this.query
      && this.currentConfig
      && this.currentConfig.restartKey !== request.restartKey
    ) {
      await this.closeCurrentQuery();
      requestSignal?.throwIfAborted();
    }
    if (this.query) {
      return;
    }

    const agentQuery = await loadClaudeAgentQuery();
    requestSignal?.throwIfAborted();
    if (this.disposed) {
      return;
    }
    if (this.query) {
      return;
    }
    const abortController = new AbortController();
    const messageChannel = new MessageChannel();
    const options: Options = {
      ...request.options,
      abortController,
    };
    const query = agentQuery({
      prompt: messageChannel,
      options,
    });
    this.abortController = abortController;
    this.messageChannel = messageChannel;
    this.query = query;
    this.currentConfig = request;
    this.consumerPromise = this.consume(query, queryToken);
  }

  private async applyDynamicUpdates(
    request: ClaudeEncodedExecutionRequest,
  ): Promise<void> {
    const query = this.query;
    const current = this.currentConfig;
    if (!query || !current) return;

    if (request.model !== current.model) {
      await query.setModel(request.model);
      if (this.query !== query || this.disposed) return;
    }
    if (request.effort !== current.effort) {
      await query.applyFlagSettings({ effortLevel: request.effort });
      if (this.query !== query || this.disposed) return;
    }
    if (request.sdkPermissionMode !== current.sdkPermissionMode) {
      await query.setPermissionMode(request.sdkPermissionMode);
      if (this.query !== query || this.disposed) return;
    }
    this.currentConfig = request;
  }

  private async consume(query: Query, queryToken: number): Promise<void> {
    try {
      for await (const message of query) {
        if (this.query !== query || this.disposed) {
          return;
        }
        if (message.type === 'system' && message.subtype === 'init') {
          this.sink.publishCommands(query, queryToken);
        }
        const nativeTurn = this.getNativeTurn(query);
        await this.sink.handleNativeMessage(
          message,
          nativeTurn?.queryToken ?? queryToken,
        );
        if (
          message.type === 'system'
          && message.subtype === 'init'
          && message.session_id
        ) {
          this.messageChannel?.setSessionId(message.session_id);
        }
        if (message.type === 'result') {
          this.messageChannel?.onTurnComplete();
          this.finishNativeTurn(query, { type: 'completed' });
        }
      }
      if (this.query === query && !this.disposed) {
        const nativeTurn = this.getNativeTurn(query);
        const nativeTurnToken = nativeTurn?.queryToken ?? queryToken;
        const error = new Error('Claude persistent query ended unexpectedly.');
        this.detachCurrentQuery(query);
        this.sink.handleNativeEnd(nativeTurnToken);
        this.finishNativeTurn(query, { type: 'failed', error });
      }
    } catch (error) {
      if (this.query === query && !this.disposed) {
        const nativeTurn = this.getNativeTurn(query);
        const nativeTurnToken = nativeTurn?.queryToken ?? queryToken;
        this.detachCurrentQuery(query);
        this.sink.handleNativeFailure(error, nativeTurnToken);
        this.finishNativeTurn(query, { type: 'failed', error });
      }
    }
  }

  private async closeCurrentQuery(): Promise<void> {
    const query = this.query;
    if (query) {
      this.detachCurrentQuery(query);
      this.finishNativeTurn(query, {
        type: 'failed',
        error: new Error('Claude persistent query was replaced.'),
      });
    }
    if (query) {
      await query.interrupt().catch(() => undefined);
    }
  }

  private getNativeTurn(query: Query): PersistentNativeTurn | null {
    return this.activeNativeTurn?.query === query
      ? this.activeNativeTurn
      : null;
  }

  private finishNativeTurn(
    query: Query,
    outcome: PersistentNativeTurnOutcome,
  ): void {
    const nativeTurn = this.getNativeTurn(query);
    if (!nativeTurn) return;
    this.activeNativeTurn = null;
    nativeTurn.settle(outcome);
  }

  private detachCurrentQuery(query: Query): void {
    if (this.query !== query) return;
    this.messageChannel?.close();
    this.abortController?.abort();
    this.query = null;
    this.messageChannel = null;
    this.abortController = null;
    this.currentConfig = null;
  }
}

export class ClaudeEphemeralExecutionStrategy
implements ClaudeExecutionStrategy {
  private activeQuery: Query | null = null;
  private activeAbortController: AbortController | null = null;
  private turnBarrier: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly sink: ClaudeExecutionStrategySink) {}

  async startTurn(
    request: ClaudeEncodedExecutionRequest,
    queryToken: number,
  ): Promise<void> {
    const turn = this.turnBarrier
      .catch(() => undefined)
      .then(() => this.runTurn(request, queryToken));
    this.turnBarrier = turn;
    await turn;
  }

  private async runTurn(
    request: ClaudeEncodedExecutionRequest,
    queryToken: number,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error('Claude ephemeral strategy is disposed');
    }
    const abortController = request.options.abortController
      ?? new AbortController();
    const options: Options = {
      ...request.options,
      abortController,
    };
    const message = buildClaudeSDKUserMessage(
      request.prompt,
      this.sink.getProviderSessionId() ?? '',
      request.images,
    );
    if (message.uuid) {
      this.sink.setPendingNativeUserMessageId(message.uuid, queryToken);
    }
    const prompt = toSingleMessagePrompt(message);
    this.activeAbortController = abortController;
    let query: Query | null = null;
    try {
      await runColdStartQuery({
        options,
        prompt,
        stopAfterResult: true,
        onQuery: (openedQuery) => {
          query = openedQuery;
          this.activeQuery = openedQuery;
          this.sink.markNativeTurnHandedOff(queryToken);
        },
        onMessage: async (message) => {
          if (
            !query
            || this.activeQuery !== query
            || this.disposed
          ) {
            return;
          }
          if (
            message.type === 'system'
            && message.subtype === 'init'
          ) {
            this.sink.publishCommands(query, queryToken);
          }
          await this.sink.handleNativeMessage(message, queryToken);
        },
      });
    } catch (error) {
      if (
        (!query || this.activeQuery === query)
        && !this.disposed
      ) {
        this.sink.handleNativeFailure(error, queryToken);
      }
    } finally {
      if (!query || this.activeQuery === query) {
        this.activeQuery = null;
        this.activeAbortController = null;
      }
      this.sink.releaseNativeTurnFence(queryToken);
    }
  }

  cancel(
    _queryToken: number | null,
    _nativeTurnHandedOff: boolean,
  ): void {
    this.activeAbortController?.abort();
    void this.activeQuery?.interrupt().catch(() => undefined);
  }

  setMode(): Promise<boolean> {
    return Promise.resolve(false);
  }

  getRewindQuery(): Query | null {
    return null;
  }

  ensureReadyForRewind(): Promise<Query | null> {
    return Promise.resolve(null);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const query = this.activeQuery;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.activeQuery = null;
    if (query) {
      await query.interrupt().catch(() => undefined);
    }
    await this.turnBarrier.catch(() => undefined);
  }
}

async function* toSingleMessagePrompt(
  message: SDKUserMessage,
): AsyncGenerator<SDKUserMessage> {
  yield message;
}

function createPersistentNativeTurn(
  query: Query,
  queryToken: number,
): PersistentNativeTurn {
  let resolve!: (outcome: PersistentNativeTurnOutcome) => void;
  const completion = new Promise<PersistentNativeTurnOutcome>(
    (innerResolve) => {
      resolve = innerResolve;
    },
  );
  let settled = false;
  return {
    query,
    queryToken,
    completion,
    settle: (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    },
  };
}
