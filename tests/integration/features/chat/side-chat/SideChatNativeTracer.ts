import { Notice } from 'obsidian';

import type {
  ProviderExecutionBackend,
  ProviderExecutionEvent,
  ProviderExecutionSession,
  ProviderInteractionPort,
  ProviderToolPolicy,
} from '@/core/execution';
import type { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatMessage, ProviderId } from '@/core/types';
import { handleForkRequest } from '@/features/chat/tabs/TabForking';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import type { FeatureHost } from '@/features/FeatureHost';

import type { ForkTestEnvironment } from '../tabs/ProviderForkTestHarness';

export interface TracedSideTurn {
  readonly accepted: boolean;
  readonly text: string;
  readonly checkpointId?: string;
  readonly terminal: ProviderExecutionEvent['type'];
  readonly errorMessage?: string;
}

export interface TracedSideChild {
  readonly session: ProviderExecutionSession;
  send(text: string, toolPolicy?: ProviderToolPolicy): Promise<TracedSideTurn>;
  providerSessionId(): string | undefined;
  dispose(): Promise<void>;
}

/**
 * Minimal neutral tracer for the selected side-chat native recipe: build the
 * opaque child fork state from a captured checkpoint, then run an independently
 * supervised persistent session seeded with that state alone. It intentionally
 * has no Claudian conversation, repository record, or accepted-input ledger.
 */
export async function traceSideChild(
  env: ForkTestEnvironment,
  chat: Awaited<ReturnType<ForkTestEnvironment['open']>>,
  checkpointMessage: ChatMessage,
  backend: ProviderExecutionBackend,
  options: {
    readonly interactionPort?: ProviderInteractionPort;
    readonly lifecycleRegistry?: ProviderExecutionLifecycleRegistry;
    readonly beforeStart?: () => Promise<void>;
    /** Overrides the inherited model when the source projection is not the enabled selection. */
    readonly model?: string;
  } = {},
): Promise<TracedSideChild | null> {
  const captured = await captureSideSource(env, chat, checkpointMessage);
  if (!captured) return null;
  await options.beforeStart?.();

  const providerState = await ProviderRegistry
    .getConversationHistoryService(captured.providerId)
    .buildForkProviderState(
      captured.sourceSessionId,
      captured.resumeAt,
      captured.sourceProviderState,
      env.root,
    );

  const registry = options.lifecycleRegistry
    ?? (env.host as unknown as { executionLifecycleRegistry: ProviderExecutionLifecycleRegistry })
      .executionLifecycleRegistry;
  const lease = registry.acquire(
    backend,
    {
      interactionPort: options.interactionPort ?? rejectingInteractionPort(),
      lifecycle: 'persistent',
      nativePersistence: 'enabled',
      // Child fork state only. The parent's provider session id is never seeded.
      resumeSeed: { providerState },
      vaultWorkingDirectory: env.root,
    },
    'chat',
  );

  const history: ChatMessage[] = [...captured.messages];
  return {
    session: lease.session,
    providerSessionId: () => lease.session.getSnapshot().providerSessionId,
    async send(text, toolPolicy) {
      const controller = new AbortController();
      const run = lease.session.execute({
        configuration: {
          model: options.model ?? captured.sourceSelectedModel,
          permissionMode: 'normal',
          systemInstructions: { instructions: 'Answer the user.', kind: 'explicit' },
        },
        conversationHistory: history,
        input: [{ text, type: 'text' }],
        signal: controller.signal,
        toolPolicy: toolPolicy ?? { kind: 'provider-default' },
      });
      const turn = await consumeRun(run);
      history.push(
        { content: text, id: `side-user-${history.length}`, role: 'user', timestamp: history.length },
        {
          assistantMessageId: turn.checkpointId,
          content: turn.text,
          id: `side-assistant-${history.length}`,
          role: 'assistant',
          timestamp: history.length,
        },
      );
      return turn;
    },
    dispose: () => lease.release(),
  };
}

export interface CapturedSideSource {
  readonly providerId: ProviderId;
  readonly sourceSessionId: string;
  readonly sourceProviderState?: Record<string, unknown>;
  readonly sourceSelectedModel?: string;
  readonly resumeAt: string;
  readonly messages: ChatMessage[];
}

/** Uses the shared fork source resolution without the durable fork creation path. */
export async function captureSideSource(
  env: ForkTestEnvironment,
  chat: Awaited<ReturnType<ForkTestEnvironment['open']>>,
  checkpointMessage: ChatMessage,
): Promise<CapturedSideSource | null> {
  const plugin = {
    app: env.app,
    settings: (env.host as unknown as { settings: unknown }).settings,
    getConversationSync: (id: string) => env.repository.getSync(id),
  } as unknown as FeatureHost;
  const tab = {
    conversationId: chat.conversation.id,
    executionCoordinator: chat.coordinator,
    providerId: chat.conversation.providerId,
    state: {
      isRewinding: false,
      isStreaming: false,
      messages: chat.conversation.messages,
    },
  } as unknown as AssembledTabRuntime;

  let captured: CapturedSideSource | null = null;
  await handleForkRequest(tab, plugin, checkpointMessage.id, async context => {
    captured = {
      messages: context.messages,
      providerId: context.providerId as ProviderId,
      resumeAt: context.resumeAt,
      sourceProviderState: context.sourceProviderState,
      sourceSelectedModel: context.sourceSelectedModel,
      sourceSessionId: context.sourceSessionId,
    };
  }, () => true);
  return captured;
}

export function rejectingInteractionPort(): ProviderInteractionPort {
  return {
    askUserQuestion: async () => { throw new Error('Unexpected side question'); },
    dismissInteraction: () => undefined,
    requestApproval: async () => { throw new Error('Unexpected side approval'); },
  };
}

/** Collected notices let a test assert an unavailable provider path. */
export function collectNotices(): { messages: string[] } {
  const collected: string[] = [];
  const NoticeMock = Notice as unknown as jest.Mock;
  if (typeof NoticeMock.mockImplementation === 'function') {
    NoticeMock.mockImplementation((message: string) => {
      collected.push(message);
      return { hide: () => undefined, setMessage: () => undefined };
    });
  }
  return { messages: collected };
}

async function consumeRun(
  run: ReturnType<ProviderExecutionSession['execute']>,
): Promise<TracedSideTurn> {
  let accepted = false;
  let text = '';
  let checkpointId: string | undefined;
  let terminal: ProviderExecutionEvent['type'] = 'cancelled';
  let errorMessage: string | undefined;
  for await (const event of run.events) {
    if (event.type === 'turn_started' && event.accepted) accepted = true;
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'turn_completed') {
      terminal = event.type;
      checkpointId = event.nativeAssistantId ?? event.nativeCheckpointId;
      break;
    }
    if (event.type === 'execution_error') {
      terminal = event.type;
      errorMessage = event.message;
      break;
    }
    if (event.type === 'cancelled') {
      terminal = event.type;
      break;
    }
  }
  return { accepted, checkpointId, errorMessage, terminal, text };
}
