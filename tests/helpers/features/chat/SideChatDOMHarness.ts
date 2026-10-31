import { createExecutionPersistence } from '@test/helpers/ChatExecutionHarness';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { Component } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderConversationHistoryService, ProviderRegistration } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import { getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { ImageContextManager } from '@/features/chat/composer/ImageContextManager';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import {
  captureLatestCompletedForkSource,
} from '@/features/chat/sessions/SessionForkSource';
import { getSessionSelectedModel } from '@/features/chat/sessions/sessionSettings';
import { SideChatController } from '@/features/chat/side-chat/SideChatController';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

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
    ...claudeProviderRegistration,
    formatQuestionReply: options.formatQuestionReply,
    resolveExecutionWorkingDirectory: options.resolveExecutionWorkingDirectory,
    capabilities: { ...claudeProviderRegistration.capabilities, providerId: 'claude', supportsFork: options.supportsFork ?? true, supportsEphemeralSessions: true, supportsEphemeralFork: options.supportsEphemeralFork, supportsForkDuringTurn: options.supportsForkDuringTurn },
    modelPolicy: ProviderRegistry.getModelPolicy('claude'),
    chatUIConfig: ProviderRegistry.getChatUIConfig('claude'),
    createExecutionBackend: () => backend,
    subagentAdapter: options.subagentAdapter,
    taskResultInterpreter: options.taskResultInterpreter ?? claudeProviderRegistration.taskResultInterpreter,
    historyService: {
      ...claudeProviderRegistration.historyService,
      buildForkProviderState: options.buildForkProviderState ?? (() => forkState),
      hydrateConversationHistory: async () => ({}),
      isPendingForkConversation: () => false,
      resolveSessionIdForConversation: () => 'main-session',
    },
    isEnabled: () => true,
  });

  const composerEl = document.body.appendChild(document.createElement('div'));
  composerEl.className = 'claudian-input-composer';
  const inputContainerEl = composerEl.appendChild(document.createElement('div'));
  inputContainerEl.className = 'claudian-input-container';
  const inputWrapperEl = inputContainerEl.appendChild(document.createElement('div'));
  inputWrapperEl.className = 'claudian-input-wrapper';
  const inputEl = inputWrapperEl.appendChild(document.createElement('textarea'));
  inputEl.placeholder = 'Ask to make changes';

  const checkpoint = options.checkpoint === undefined ? 'checkpoint-1' : options.checkpoint;
  const messages: ChatMessage[] = [
    { content: 'Remember A', id: 'u1', role: 'user', timestamp: testDate().getTime() },
    {
      ...(checkpoint ? { assistantMessageId: checkpoint } : {}),
      content: 'Noted A', id: 'a1', role: 'assistant', timestamp: testDate({ seconds: 1 }).getTime(),
    },
  ];
  const conversation = conversationRecord('conversation-1', { sessionId: 'main-session', messages });
  const pool = createSessionRuntimePool(() => plugin);
  const messaging = new SessionMessagingService({
    getHost: () => plugin,
    getActiveConversationId: () => tab.conversationId,
    refreshModelControls: () => undefined,
  });
  const plugin = await createChatFeatureHost({
    sessionRuntimes: pool, executionPersistence: createExecutionPersistence(),
    bindSessionTools: id => messaging.bindSessionTools(id),
    getConversationSync: () => conversation,
    getConversationById: async () => conversation,
    updateConversation: async () => undefined,
    renameConversation: async () => undefined,
    getConversationSummary: id => plugin.getConversationSync(id),
    settings: { enableAutoTitleGeneration: false, ...options.settings },
    projects: createProjectsFake(),
  });

  const component = new Component();
  const tab = await createTabRuntime({
    plugin, component, containerEl: document.createElement('div'), conversation, tabId: 'tab-1',
    mentionDataProvider: new VaultMentionDataProvider(plugin.app), getProviderCatalogConfig: () => null,
    isRuntimeLive: () => true, openConversation: async () => undefined, startNewConversation: async () => undefined,
  });
  tab.state.messages = messages;
  tab.hydrationState = 'ready';
  const imageContextManager = new ImageContextManager(plugin.app.keymap, inputWrapperEl, inputEl, {});
  const settings = plugin.settings;
  const lifecycleRegistry = plugin.providerHost.executionLifecycleRegistry;
  const destinationChanges: string[] = [];
  const drafts: ComposerDraftController = new ComposerDraftController({
    getInput: () => inputEl, getImages: () => imageContextManager, getDestination: () => controller.destination,
  });
  const controller = new SideChatController({
    drafts,
    parent: {
      get conversationId() { return tab.conversationId; },
      get providerId() { return tab.providerId; },
      get isLive() { return true; },
      getSettings: () => getChatSettingsSnapshot(settings, tab.providerId!, getSessionSelectedModel(tab, plugin)),
      captureForkSource: () => captureLatestCompletedForkSource({
        ...tab, settledTranscriptEnd: messages => tab.controllers.inputController.settledTranscriptEnd(messages),
      }, plugin, () => true),
    },
    onDestinationChanged: () => { destinationChanges.push(controller.destination); options.onDestinationChanged?.(); },
    plugin,
  });
  controller.attachPresentation({ component: new Component(), composerEl, inputWrapperEl, getInputEl: () => inputEl });
  cleanups.push(async () => {
    await controller.dispose();
    imageContextManager.destroy();
    await destroyTab(tab);
    await pool.dispose();
    component.unload();
    await messaging.dispose();
    await lifecycleRegistry.dispose();
    ProviderRegistry.register('claude', claudeProviderRegistration);
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
