import type { ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';

import type {
  ProviderExecutionBackend,
  ProviderExecutionEvent,
  ProviderInteractionPort,
  ProviderToolPolicy,
} from '@/core/execution';
import type { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatMessage, ImageAttachment, ProviderId } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { SideChatSession } from '@/features/chat/side-chat/SideChatSession';
import { handleForkRequest } from '@/features/chat/tabs/TabForking';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

export const capturedImage: ImageAttachment = {
  id: 'captured-image', name: 'captured.png', mediaType: 'image/png', source: 'paste', size: 68,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3S8AAAAASUVORK5CYII=',
};

export interface TracedSideTurn {
  readonly accepted: boolean;
  readonly text: string;
  readonly checkpointId?: string;
  readonly terminal: ProviderExecutionEvent['type'];
  readonly errorMessage?: string;
}

export interface TracedSideChild {
  readonly session: SideChatSession;
  send(text: string, toolPolicy?: ProviderToolPolicy): Promise<TracedSideTurn>;
  providerSessionId(): string | undefined;
  dispose(): Promise<void>;
}

/** Runs the production side owner against a native provider boundary. */
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

  const capabilities = ProviderRegistry.getCapabilities(captured.providerId);
  const ephemeral = capabilities.supportsEphemeralFork ?? capabilities.supportsEphemeralSessions;
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
  let responseText = '';
  const session = new SideChatSession({
    providerId: captured.providerId,
    ephemeral,
    buildChildResumeState: async () => providerState,
    resolveBackend: () => backend,
    lifecycleRegistry: registry,
    interactionPort: options.interactionPort ?? rejectingInteractionPort(),
    vaultWorkingDirectory: env.root,
    onRequestedEvent: event => { if (event.type === 'text_delta') responseText += event.text; },
  });

  const history: ChatMessage[] = [...captured.messages];
  return {
    session,
    providerSessionId: () => session.providerSessionId,
    async send(text, toolPolicy) {
      responseText = '';
      const result = await session.execute({
        configuration: {
          model: options.model ?? captured.sourceSelectedModel,
          permissionMode: 'normal',
          systemInstructions: { instructions: 'Answer the user.', kind: 'explicit' },
        },
        conversationHistory: history,
        text,
        images: [],
        toolPolicy: toolPolicy ?? { kind: 'provider-default' },
      });
      const turn: TracedSideTurn = {
        accepted: result.accepted,
        checkpointId: result.checkpointId,
        errorMessage: result.error?.message,
        terminal: result.status === 'completed' ? 'turn_completed'
          : result.status === 'cancelled' ? 'cancelled' : 'execution_error',
        text: responseText,
      };
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
    dispose: () => session.dispose(),
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
  } as unknown as ChatFeatureHost;
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
