import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { Component } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderConversationHistoryService, ProviderRegistration } from '@/core/providers/types';
import { getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import {
  captureLatestCompletedForkSource,
  type LiveForkSourceOwner,
} from '@/features/chat/sessions/SessionForkSource';
import { getSessionSelectedModel } from '@/features/chat/sessions/sessionSettings';
import { SideChatController } from '@/features/chat/side-chat/SideChatController';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

const cleanups: Array<() => Promise<void>> = [];

export async function releaseSideChatHarnesses(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  vi.clearAllMocks();
}

export async function createHarness(options: {
  formatQuestionReply?: ProviderRegistration['formatQuestionReply'];
  resolveExecutionWorkingDirectory?: ProviderRegistration['resolveExecutionWorkingDirectory'];
  onDestinationChanged?: () => void;
  subagentAdapter?: ProviderRegistration['subagentAdapter'];
  taskResultInterpreter?: ProviderRegistration['taskResultInterpreter'];
  supportsFork?: boolean;
  checkpoint?: string | null;
  settings?: Record<string, unknown>;
  supportsEphemeralFork?: boolean;
  supportsForkDuringTurn?: boolean;
  buildForkProviderState?: ProviderConversationHistoryService['buildForkProviderState'];
} = {}) {
  const backend = new FakeSideBackend();
  const forkState = { forkSource: { resumeAt: 'checkpoint-1', sessionId: 'main-session' } };
  ProviderRegistry.register('claude', {
    formatQuestionReply: options.formatQuestionReply,
    resolveExecutionWorkingDirectory: options.resolveExecutionWorkingDirectory,
    capabilities: { providerId: 'claude', supportsFork: options.supportsFork ?? true, supportsEphemeralSessions: true, supportsEphemeralFork: options.supportsEphemeralFork, supportsForkDuringTurn: options.supportsForkDuringTurn },
    modelPolicy: ProviderRegistry.getModelPolicy('claude'),
    chatUIConfig: ProviderRegistry.getChatUIConfig('claude'),
    createExecutionBackend: () => backend,
    subagentAdapter: options.subagentAdapter,
    taskResultInterpreter: options.taskResultInterpreter,
    historyService: {
      buildForkProviderState: options.buildForkProviderState ?? (() => forkState),
      hydrateConversationHistory: async () => ({}),
      isPendingForkConversation: () => false,
      resolveSessionIdForConversation: () => 'main-session',
    },
    isEnabled: () => true,
  } as unknown as ProviderRegistration);

  const composerEl = document.body.appendChild(document.createElement('div'));
  composerEl.className = 'claudian-input-composer';
  const inputContainerEl = composerEl.appendChild(document.createElement('div'));
  inputContainerEl.className = 'claudian-input-container';
  const inputWrapperEl = inputContainerEl.appendChild(document.createElement('div'));
  inputWrapperEl.className = 'claudian-input-wrapper';
  const inputEl = inputWrapperEl.appendChild(document.createElement('textarea'));
  inputEl.placeholder = 'Ask to make changes';

  let images: unknown[] = [];
  const imageContextManager = {
    clearImages: () => { images = []; },
    getAttachedImages: () => images,
    hasImages: () => images.length > 0,
    setImages: (next: unknown[]) => { images = next; },
  };

  const checkpoint = options.checkpoint === undefined ? 'checkpoint-1' : options.checkpoint;
  const messages = [
    { content: 'Remember A', id: 'u1', role: 'user', timestamp: 1 },
    {
      ...(checkpoint ? { assistantMessageId: checkpoint } : {}),
      content: 'Noted A', id: 'a1', role: 'assistant', timestamp: 2,
    },
  ];
  const tab = {
    settledTranscriptEnd: (messages: readonly unknown[]) => messages.length,
    conversationId: 'conversation-1',
    controllers: {},
    executionCoordinator: { resolveForkSource: async () => ({ resumeAt: checkpoint, sessionId: 'main-session' }) },
    id: 'tab-1',
    providerId: 'claude',
    state: { isRewinding: false, isStreaming: false, messages },
  } as unknown as AssembledTabRuntime & LiveForkSourceOwner;

  const messaging = new SessionMessagingService({
    getHost: () => plugin,
    getActiveConversationId: () => tab.conversationId,
    refreshModelControls: () => undefined,
  });
  const plugin = await createChatFeatureHost({
    bindSessionTools: id => messaging.bindSessionTools(id),
    getConversationSummary: id => plugin.getConversationSync(id),
    settings: { enableAutoTitleGeneration: false, ...options.settings },
    projects: createProjectsFake(),
  });

  const settings = plugin.settings;
  const lifecycleRegistry = plugin.providerHost.executionLifecycleRegistry;
  const destinationChanges: string[] = [];
  const drafts: ComposerDraftController = new ComposerDraftController({
    getInput: () => inputEl, getImages: () => imageContextManager as never, getDestination: () => controller.destination,
  });
  const controller = new SideChatController({
    drafts,
    parent: {
      get conversationId() { return tab.conversationId; },
      get providerId() { return tab.providerId; },
      get isLive() { return true; },
      getSettings: () => getChatSettingsSnapshot(settings, tab.providerId!, getSessionSelectedModel(tab, plugin)),
      captureForkSource: () => captureLatestCompletedForkSource(tab, plugin, () => true),
    },
    onDestinationChanged: () => { destinationChanges.push(controller.destination); options.onDestinationChanged?.(); },
    plugin,
  });
  controller.attachPresentation({ component: new Component(), composerEl, inputWrapperEl, getInputEl: () => inputEl as never });
  cleanups.push(async () => {
    await controller.dispose();
    await messaging.dispose();
    await lifecycleRegistry.dispose();
  });
  return {
    backend, composerEl, controller, drafts, destinationChanges, imageContextManager,
    inputContainerEl, inputEl, inputWrapperEl, lifecycleRegistry, plugin, tab,
  };
}

/** Returns a holder so the pending submission is not unwrapped by `await`. */
export async function startSideChat(
  harness: SideChatDOMHarness,
  prompt = 'Explore B',
): Promise<{ started: Promise<boolean> }> {
  const request = harness.backend.nextRequest(request => request.toolPolicy.kind === 'provider-default');
  const started = harness.controller.handleCommandSubmission(prompt, []);
  expect((await request).toolPolicy.kind).toBe('provider-default');
  return { started };
}

export type SideChatDOMHarness = Awaited<ReturnType<typeof createHarness>>;
