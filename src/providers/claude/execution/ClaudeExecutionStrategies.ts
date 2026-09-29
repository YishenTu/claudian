import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';

import { loadClaudeAgentQuery } from '../loadClaudeAgentSDK';
import { MessageChannel } from '../runtime/ClaudeMessageChannel';
import {
  buildClaudeSDKUserMessage,
  type ClaudeSDKUserMessage,
} from '../runtime/ClaudeUserMessageFactory';
import type { ClaudeEncodedExecutionRequest } from './ClaudeExecutionRequestEncoder';
import { ClaudeTurnInputs } from './ClaudeTurnInputs';

export interface ClaudeExecutionStrategySink {
  readonly sessionInstanceId: string;
  getProviderSessionId(): string | null;
  assertModelAvailable(model: string): void;
  bindNativeTurnInputs(inputs: ClaudeTurnInputs, queryToken: number): void;
  markNativeTurnHandedOff(queryToken: number): void;
  handleNativeMessage(message: SDKMessage, queryToken: number): Promise<void>;
  handleNativeFailure(error: unknown, queryToken: number): void;
  handleNativeEnd(queryToken: number): void;
  releaseNativeTurnFence(queryToken: number): void;
  handleNativeQueryOpened(query: Query): void;
  handleNativeQueryClosed(query: Query): void;
  publishCommands(query: Query, commands?: SlashCommand[]): void;
  publishModels(query: Query): void;
}

export interface ClaudeExecutionStrategy {
  startTurn(
    request: ClaudeEncodedExecutionRequest,
    queryToken: number,
  ): Promise<void>;
  /**
   * Hands a steer to the live native turn for `queryToken`. Returns false only
   * when nothing was handed off.
   */
  steerTurn(message: ClaudeSDKUserMessage, queryToken: number): boolean;
  cancel(queryToken: number | null, nativeTurnHandedOff: boolean): void;
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
  readonly inputs: ClaudeTurnInputs;
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
  private hasNonPersistentContext = false;
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
      await this.#ensureQuery(request, queryToken);
      requestSignal?.throwIfAborted();
      if (!this.query || !this.messageChannel) {
        throw new Error('Claude persistent query is unavailable');
      }

      await this.#applyDynamicUpdates(request);
      requestSignal?.throwIfAborted();
      const message = buildClaudeSDKUserMessage(
        request.prompt,
        this.sink.getProviderSessionId() ?? '',
        request.images,
      );
      const inputs = new ClaudeTurnInputs(message.uuid);
      this.sink.bindNativeTurnInputs(inputs, queryToken);
      requestSignal?.throwIfAborted();
      const query = this.query;
      this.sink.assertModelAvailable(request.model);
      this.messageChannel.enqueue(message);
      this.activeNativeTurn = createPersistentNativeTurn(query, queryToken, inputs);
      this.hasNonPersistentContext ||= request.options.persistSession === false;
      this.sink.markNativeTurnHandedOff(queryToken);
    } finally {
      if (this.preparingTurnToken === queryToken) {
        this.preparingTurnToken = null;
      }
    }
  }

  steerTurn(message: ClaudeSDKUserMessage, queryToken: number): boolean {
    const nativeTurn = this.activeNativeTurn;
    if (
      this.disposed
      || !nativeTurn
      || nativeTurn.queryToken !== queryToken
      || nativeTurn.query !== this.query
      || nativeTurn.inputs.settled
      || !this.messageChannel
      // Recalling a queued steer restarts the process, which non-persistent context cannot survive.
      || this.hasNonPersistentContext
    ) {
      return false;
    }
    nativeTurn.inputs.addSteer(message.uuid);
    // 'next' folds at the next native boundary; 'now' would abort the running tool.
    this.messageChannel.enqueue({ ...message, priority: 'next' });
    return true;
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
      void this.#closeCurrentQuery().catch(() => undefined);
      return;
    }
    const nativeTurn = this.activeNativeTurn;
    if (
      nativeTurnHandedOff
      && (
        queryToken === null
        || nativeTurn?.queryToken === queryToken
      )
    ) {
      if (nativeTurn?.inputs.hasUndeliveredSteers()) {
        // Queued sends survive a native interrupt; ending the process recalls them.
        void this.#closeCurrentQuery().catch(() => undefined);
        return;
      }
      void this.query?.interrupt().catch(() => undefined);
    }
  }

  getRewindQuery(): Query | null {
    return this.query;
  }

  async ensureReadyForRewind(
    request: ClaudeEncodedExecutionRequest,
    queryToken: number,
  ): Promise<Query | null> {
    await this.#ensureQuery(request, queryToken);
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
      this.sink.handleNativeQueryClosed(query);
      this.#finishNativeTurn(query, {
        type: 'failed',
        error: new Error('Claude persistent query was disposed.'),
      });
      await query.interrupt().catch(() => undefined);
    }
    await this.consumerPromise?.catch(() => undefined);
    this.consumerPromise = null;
    this.currentConfig = null;
  }

  async #ensureQuery(
    request: ClaudeEncodedExecutionRequest,
    queryToken: number,
  ): Promise<void> {
    const requestSignal = request.options.abortController?.signal;
    requestSignal?.throwIfAborted();
    if (this.disposed) {
      throw new Error('Claude persistent strategy is disposed');
    }
    if (
      this.hasNonPersistentContext
      && (
        !this.query
        || this.currentConfig?.restartKey !== request.restartKey
      )
    ) {
      throw new Error(
        'This non-persistent Claude session cannot be restored after its configuration or process changes. Start a new request.',
      );
    }
    if (
      this.query
      && this.currentConfig
      && this.currentConfig.restartKey !== request.restartKey
    ) {
      await this.#closeCurrentQuery();
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
    this.sink.handleNativeQueryOpened(query);
    this.consumerPromise = this.#consume(query, queryToken);
  }

  async #applyDynamicUpdates(
    request: ClaudeEncodedExecutionRequest,
  ): Promise<void> {
    const query = this.query;
    const current = this.currentConfig;
    if (!query || !current) return;

    if (request.model !== current.model) {
      await query.setModel(request.model);
      if (this.query !== query || this.disposed) return;
    }
    const flagSettings: Parameters<Query['applyFlagSettings']>[0] = {
      ...(request.effort !== current.effort
        ? { effortLevel: request.effort }
        : {}),
      ...(request.responseStyle !== current.responseStyle
        ? { outputStyle: request.responseStyle }
        : {}),
    };
    if (Object.keys(flagSettings).length > 0) {
      await query.applyFlagSettings(flagSettings);
      if (this.query !== query || this.disposed) return;
    }
    if (request.sdkPermissionMode !== current.sdkPermissionMode) {
      await query.setPermissionMode(request.sdkPermissionMode);
      if (this.query !== query || this.disposed) return;
    }
    this.currentConfig = request;
  }

  async #consume(query: Query, queryToken: number): Promise<void> {
    try {
      for await (const message of query) {
        if (this.query !== query || this.disposed) {
          return;
        }
        if (message.type === 'system' && message.subtype === 'init') {
          this.sink.publishCommands(query);
          this.sink.publishModels(query);
        }
        if (message.type === 'system' && message.subtype === 'commands_changed') {
          this.sink.publishCommands(query, message.commands);
        }
        const nativeTurn = this.#getNativeTurn(query);
        nativeTurn?.inputs.observe(message);
        await this.sink.handleNativeMessage(
          message,
          nativeTurn?.queryToken ?? queryToken,
        );
        if (message.type === 'result' && nativeTurn?.inputs.settled) {
          this.#finishNativeTurn(query, { type: 'completed' });
        }
      }
      if (this.query === query && !this.disposed) {
        const nativeTurn = this.#getNativeTurn(query);
        const nativeTurnToken = nativeTurn?.queryToken ?? queryToken;
        const error = new Error('Claude persistent query ended unexpectedly.');
        this.#detachCurrentQuery(query);
        this.sink.handleNativeEnd(nativeTurnToken);
        this.#finishNativeTurn(query, { type: 'failed', error });
      }
    } catch (error) {
      if (this.query === query && !this.disposed) {
        const nativeTurn = this.#getNativeTurn(query);
        const nativeTurnToken = nativeTurn?.queryToken ?? queryToken;
        this.#detachCurrentQuery(query);
        this.sink.handleNativeFailure(error, nativeTurnToken);
        this.#finishNativeTurn(query, { type: 'failed', error });
      }
    }
  }

  async #closeCurrentQuery(): Promise<void> {
    const query = this.query;
    if (query) {
      this.#detachCurrentQuery(query);
      this.#finishNativeTurn(query, {
        type: 'failed',
        error: new Error('Claude persistent query was replaced.'),
      });
    }
    if (query) {
      await query.interrupt().catch(() => undefined);
    }
  }

  #getNativeTurn(query: Query): PersistentNativeTurn | null {
    return this.activeNativeTurn?.query === query
      ? this.activeNativeTurn
      : null;
  }

  #finishNativeTurn(
    query: Query,
    outcome: PersistentNativeTurnOutcome,
  ): void {
    const nativeTurn = this.#getNativeTurn(query);
    if (!nativeTurn) return;
    this.activeNativeTurn = null;
    nativeTurn.settle(outcome);
  }

  #detachCurrentQuery(query: Query): void {
    if (this.query !== query) return;
    this.messageChannel?.close();
    this.abortController?.abort();
    this.query = null;
    this.messageChannel = null;
    this.abortController = null;
    this.currentConfig = null;
    this.sink.handleNativeQueryClosed(query);
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
      .then(() => this.#runTurn(request, queryToken));
    this.turnBarrier = turn;
    await turn;
  }

  async #runTurn(
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
    const inputs = new ClaudeTurnInputs(message.uuid);
    this.sink.bindNativeTurnInputs(inputs, queryToken);
    const prompt = toSingleMessagePrompt(message);
    this.activeAbortController = abortController;
    let query: Query | null = null;
    try {
      const agentQuery = await loadClaudeAgentQuery();
      abortController.signal.throwIfAborted();
      this.sink.assertModelAvailable(request.model);
      query = agentQuery({ options, prompt });
      this.activeQuery = query;
      this.sink.handleNativeQueryOpened(query);
      this.sink.markNativeTurnHandedOff(queryToken);
      for await (const message of query) {
        if (this.activeQuery !== query || this.disposed) break;
        if (message.type === 'system' && message.subtype === 'init') {
          this.sink.publishCommands(query);
          this.sink.publishModels(query);
        }
        if (message.type === 'system' && message.subtype === 'commands_changed') {
          this.sink.publishCommands(query, message.commands);
        }
        inputs.observe(message);
        await this.sink.handleNativeMessage(message, queryToken);
        if (message.type === 'result') break;
      }
    } catch (error) {
      if (
        (!query || this.activeQuery === query)
        && !this.disposed
      ) {
        this.sink.handleNativeFailure(error, queryToken);
      }
    } finally {
      if (!query || this.activeQuery === query) {
        if (query) {
          this.sink.handleNativeQueryClosed(query);
        }
        this.activeQuery = null;
        this.activeAbortController = null;
      }
      this.sink.releaseNativeTurnFence(queryToken);
    }
  }

  steerTurn(): boolean {
    // A single-message prompt closes native input after its first send.
    return false;
  }

  cancel(
    _queryToken: number | null,
    _nativeTurnHandedOff: boolean,
  ): void {
    this.activeAbortController?.abort();
    void this.activeQuery?.interrupt().catch(() => undefined);
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
      this.sink.handleNativeQueryClosed(query);
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
  inputs: ClaudeTurnInputs,
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
    inputs,
    completion,
    settle: (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    },
  };
}
