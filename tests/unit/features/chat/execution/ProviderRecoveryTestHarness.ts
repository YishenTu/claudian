import type {
  ProviderExecutionBackend,
  ProviderExecutionConfiguration,
  ProviderInteractionPort,
  ProviderSessionSnapshot,
  ProviderToolPolicy,
} from '@/core/execution';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { Conversation } from '@/core/types';
import {
  ChatExecutionCoordinator,
  type ChatExecutionPersistence,
  type ChatExecutionResult,
  type MissingProviderSessionResolution,
} from '@/features/chat/execution/ChatExecutionCoordinator';

interface ProviderRecoveryTestHarnessOptions {
  readonly backend: ProviderExecutionBackend;
  readonly configuration: ProviderExecutionConfiguration;
  readonly conversation: Conversation;
  readonly resolveMissingProviderSession: (
    conversation: Conversation,
    missingProviderSessionId?: string,
  ) => Promise<MissingProviderSessionResolution>;
  readonly toolPolicy?: ProviderToolPolicy;
  readonly vaultWorkingDirectory: string;
}

export interface ProviderRecoveryTestHarness {
  readonly coordinator: ChatExecutionCoordinator;
  readonly createSessionSpy: jest.SpyInstance;
  execute(): Promise<ChatExecutionResult>;
}

export function createProviderRecoveryTestHarness(
  options: ProviderRecoveryTestHarnessOptions,
): ProviderRecoveryTestHarness {
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const createSessionSpy = jest.spyOn(options.backend, 'createSession');
  const persistence: ChatExecutionPersistence = {
    registerExecutionBinding: jest.fn(),
    persistExecutionSnapshot: jest.fn(async (
      _conversationId,
      _bindingId,
      _providerGeneration,
      snapshot,
    ) => {
      applySnapshot(options.conversation, snapshot);
      return true;
    }),
    releaseExecutionBinding: jest.fn(),
    stageConversationInput: jest.fn(async () => undefined),
    assertConversationExecutionAuthority: jest.fn(async () => undefined),
    acceptConversationInput: jest.fn(async () => undefined),
    discardStagedConversationInput: jest.fn(async () => undefined),
    copyConversationInputsForFork: jest.fn(async () => undefined),
    truncateConversationInputsFrom: jest.fn(async () => undefined),
  };
  const interactionPort = {
    askUserQuestion: jest.fn(),
    dismissInteraction: jest.fn(),
    requestApproval: jest.fn(),
    requestPlanDecision: jest.fn(),
  } as unknown as ProviderInteractionPort;
  let nextId = 0;
  const coordinator = new ChatExecutionCoordinator({
    lifecycleRegistry,
    resolveBackend: () => options.backend,
    persistence,
    interactionPort,
    vaultWorkingDirectory: options.vaultWorkingDirectory,
    createId: () => `provider-recovery-${++nextId}`,
    resolveMissingProviderSession: (_conversationId, missingProviderSessionId) => (
      options.resolveMissingProviderSession(
        options.conversation,
        missingProviderSessionId,
      )
    ),
  });

  return {
    coordinator,
    createSessionSpy,
    execute: async () => {
      await coordinator.bindConversation({
        conversationId: options.conversation.id,
        providerId: options.conversation.providerId,
        resumeSeed: {
          ...(options.conversation.sessionId
            ? { providerSessionId: options.conversation.sessionId }
            : {}),
          ...(options.conversation.providerState
            ? { providerState: options.conversation.providerState }
            : {}),
          ...(options.conversation.resumeAtMessageId
            ? { resumeCheckpoint: options.conversation.resumeAtMessageId }
            : {}),
        },
      });
      return coordinator.execute({
        inputRecordId: 'provider-recovery-input',
        userTurnOrdinal: 1,
        timestamp: 1,
        rawDisplayText: 'Retry this turn',
        canonicalText: 'Retry this turn',
        images: [],
        conversationHistory: [],
        configuration: options.configuration,
        toolPolicy: options.toolPolicy ?? { kind: 'provider-default' },
      });
    },
  };
}

function applySnapshot(
  conversation: Conversation,
  snapshot: ProviderSessionSnapshot,
): void {
  if (snapshot.providerSessionId !== undefined) {
    conversation.sessionId = snapshot.providerSessionId;
  } else if (snapshot.status === 'invalidated') {
    conversation.sessionId = null;
  }
  if (
    snapshot.providerState !== undefined
    || snapshot.providerStateDeletes !== undefined
  ) {
    const providerState = { ...conversation.providerState };
    for (const key of snapshot.providerStateDeletes ?? []) {
      delete providerState[key];
    }
    Object.assign(providerState, snapshot.providerState);
    conversation.providerState = Object.keys(providerState).length > 0
      ? providerState
      : undefined;
  }
}
