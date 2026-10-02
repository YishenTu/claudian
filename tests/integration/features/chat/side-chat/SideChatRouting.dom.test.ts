/** @jest-environment jsdom */
import '@/providers';

import { deferred } from '@test/helpers/ChatInputHarness';
import { createConversationPorts } from '@test/helpers/ConversationPorts';
import {
  createHarness,
  releaseSideChatHarnesses,
  type SideChatDOMHarness,
  startSideChat,
} from '@test/helpers/features/chat/SideChatDOMHarness';
import { testDate } from '@test/helpers/testClock';
import { waitFor } from '@testing-library/dom';

import type { ProviderExecutionContext } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatMessage, ImageAttachment } from '@/core/types';
import { ConversationController } from '@/features/chat/controllers/ConversationController';
import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';
import { ChatExecutionPreHandoffError } from '@/features/chat/execution/ChatExecutionCoordinator';
import { cancelSelectedDestinationTurn } from '@/features/chat/tabs/TabInputEvents';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

afterEach(releaseSideChatHarnesses);

function createRouting(
  harness: SideChatDOMHarness,
  context: ProviderExecutionContext = {},
  failAt?: 'initialization' | 'missing-coordinator' | 'handoff',
) {
  const mainExecutions: string[] = [];
  const mainMessages: ChatMessage[] = [];
  const state = {
    acknowledgeReview: () => undefined,
    addMessage: (message: ChatMessage) => { mainMessages.push(message); },
    isCreatingConversation: false,
    isRewinding: false,
    bumpStreamGeneration: () => 1,
    cancelRequested: false,
    clearFlavorTimerInterval: () => undefined,
    currentContentEl: null,
    currentConversationId: 'conversation-1',
    writeEditStates: new Map(),
    hasPendingConversationSave: false,
    isStreaming: false,
    isSwitchingConversation: false,
    messages: [] as ChatMessage[],
    responseStartTime: null,
    streamGeneration: 1,
    queuedMessage: null as unknown,
    queueIndicatorEl: null,
  };
  const deps = {
    drafts: harness.drafts,
    getSettings: () => ({ model: 'claude-model', reasoning: 'high', permissionMode: 'normal', serviceTier: 'default' }),
    canvasSelectionController: { getContext: () => context.canvasSelection ?? null },
    browserSelectionController: { getContext: () => context.browserSelection ?? null },
    conversationController: { save: async () => undefined, commitBranchDraft: async () => true, cancelBranchDraft: () => undefined },
    ensureExecutionInitialized: async () => failAt !== 'initialization',
    getExecutionCoordinator: () => failAt === 'missing-coordinator' ? null : ({
      cancel: () => { mainExecutions.push('<cancelled>'); },
      execute: async (submission: { canonicalText: string }) => {
        mainExecutions.push(submission.canonicalText);
        if (failAt === 'handoff') throw new ChatExecutionPreHandoffError('Preparation failed');
        return { accepted: true, status: 'completed' };
      },
    }),
    getImageContextManager: () => harness.imageContextManager,
    getInputContainerEl: () => harness.inputContainerEl,
    getInputEl: () => harness.inputEl,
    getSideChatController: () => harness.controller,
    getTabProviderId: () => 'claude',
    generateId: () => `main-${mainExecutions.length}`,
    getMessagesEl: () => document.body,
    getLinkedContentController: () => ({
      beginSubmission: () => null,
      getSnapshot: () => ({ path: null }),
      rollbackSubmission: () => undefined,
    }),
    getSubagentManager: () => ({
      resetSpawnedCount: () => undefined,
      resetStreamingState: () => undefined,
    }),
    getWelcomeEl: () => null,
    plugin: harness.plugin,
    renderer: {
      addMessage: () => document.createElement('div'),
      finalizeResponse: () => undefined,
      refreshActionButtons: () => undefined,
    },
    selectionController: { getContext: () => context.editorSelection ?? null },
    state,
    streamController: {
      resetSubagentStreamingState: () => undefined,
      appendText: async () => undefined,
      finalizeCurrentTextBlock: async () => undefined,
      finalizeCurrentThinkingBlock: async () => undefined,
      hideThinkingIndicator: () => undefined,
      showThinkingIndicator: () => undefined,
    },
  } as unknown as InputControllerDeps;
  const controller = new InputController(deps);

  const tab = {
    controllers: { inputController: controller, sideChatController: harness.controller },
    state,
  } as unknown as AssembledTabRuntime;
  return { controller, deps, mainExecutions, mainMessages, state, tab };
}

it('starts a side chat from a submitted command instead of sending it to main', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  harness.inputEl.value = '/side Explore an append-only log';

  const sent = routing.controller.sendMessage();
  await waitFor(() => expect(harness.backend.sessions).toHaveLength(1));
  expect(harness.inputEl.value).toBe('');
  expect(routing.mainExecutions).toEqual([]);
  expect(harness.backend.latest.requests[0].input).toEqual([
    { text: 'Explore an append-only log', type: 'text' },
  ]);

  expect(harness.backend.latest.config).toMatchObject({
    lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported',
  });
  expect(harness.backend.latest.config.resumeSeed).toMatchObject({ providerState: expect.any(Object) });
  expect(harness.backend.latest.requests[0].conversationHistory).toEqual(harness.tab.state.messages);

  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await sent;
  expect(harness.controller.destination).toBe('side');
});

it('routes ordinary composer input to the selected destination', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;

  harness.inputEl.value = 'Follow up in the side chat';
  const sideSend = routing.controller.sendMessage();
  await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(2));
  harness.backend.latest.complete();
  await sideSend;
  expect(routing.mainExecutions).toEqual([]);

  harness.controller.collapse();
  harness.inputEl.value = 'Back in main';
  await routing.controller.sendMessage();
  expect(routing.mainExecutions).toEqual(['Back in main']);
  expect(harness.backend.latest.requests).toHaveLength(2);
});

it('cancels only the selected destination', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;

  expect(cancelSelectedDestinationTurn(routing.tab)).toBe(true);
  expect(await started).toBe(true);
  expect(native.cancelCalls).toBe(1);

  routing.state.isStreaming = true;
  harness.controller.collapse();
  const cancelMain = jest.spyOn(routing.controller, 'cancelStreaming');
  expect(cancelSelectedDestinationTurn(routing.tab)).toBe(true);
  expect(cancelMain).toHaveBeenCalledTimes(1);
  expect(native.cancelCalls).toBe(1);
});

it('keeps main-only commands and nested side commands out of the child', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;

  for (const command of ['/clear', '/fork', '/side nested', '/btw nested']) {
    harness.inputEl.value = command;
    await routing.controller.sendMessage();
  }
  expect(harness.backend.latest.requests).toHaveLength(1);
  expect(routing.mainExecutions).toEqual([]);
  expect(harness.controller.destination).toBe('side');
});

it('preserves a queued main message while the side chat runs', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;

  routing.state.queuedMessage = { content: 'queued main text', images: undefined };
  harness.inputEl.value = 'side turn while main has a queue';
  const sideSend = routing.controller.sendMessage();
  await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(2));
  harness.backend.latest.complete();
  await sideSend;

  expect(routing.state.queuedMessage).toEqual({ content: 'queued main text', images: undefined });
  expect(routing.mainExecutions).toEqual([]);
});

it.each([false, true])('dispatches queued main input to main with side working=%s', async (sideWorking) => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;

  const sideTurn = sideWorking
    ? harness.controller.submitToSide('Independent side work', [])
    : null;
  await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(sideWorking ? 2 : 1));
  routing.state.queuedMessage = { content: 'Queued main work', images: undefined };
  harness.inputEl.value = 'Unsent side draft';
  routing.controller.resumeQueuedTurnAfterIntentAdmission();

  try {
    await waitFor(() => expect(routing.mainExecutions).toEqual(['Queued main work']));
    expect(harness.inputEl.value).toBe('Unsent side draft');
    expect(harness.backend.latest.requests.map(request => request.input)).toEqual([
      [{ text: 'Explore B', type: 'text' }],
      ...(sideWorking ? [[{ text: 'Independent side work', type: 'text' }]] : []),
    ]);
  } finally {
    harness.backend.latest.complete();
    await sideTurn;
  }
});

it('forwards captured selection context on initial, expanded, and collapsed side submissions', async () => {
  const harness = createHarness();
  const context: ProviderExecutionContext = {
    editorSelection: { mode: 'selection', notePath: 'Design.md', selectedText: 'Original selection' },
    browserSelection: { source: 'browser', selectedText: 'Browser excerpt', url: 'https://example.com' },
    canvasSelection: { canvasPath: 'Design.canvas', nodeIds: ['node-1'] },
  };
  const routing = createRouting(harness, context);
  for (const [index, prompt] of ['/side Initial question', 'Expanded follow-up', '/side Collapsed follow-up'].entries()) {
    if (index === 2) harness.controller.collapse();
    context.editorSelection!.selectedText = `Selection ${index}`;
    const expected = JSON.parse(JSON.stringify(context));
    harness.inputEl.value = prompt;
    const sent = routing.controller.sendMessage();
    context.editorSelection!.selectedText = 'Selection changed during preparation';
    await waitFor(() => expect(harness.backend.sessions).toHaveLength(1));
    await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(index + 1));
    harness.backend.latest.establishChild('child-session');
    harness.backend.latest.complete();
    await sent;
    expect(harness.backend.latest.requests[index].context).toEqual(expected);
  }
});

it('keeps unsent side attachments out of a text-only queued main message', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  const sideImage = { id: 'side-image', name: 'side.png', mediaType: 'image/png', data: 'c2lkZQ==' };
  harness.imageContextManager.setImages([sideImage]);
  routing.state.queuedMessage = { content: 'Text-only main work', images: undefined };
  routing.controller.resumeQueuedTurnAfterIntentAdmission();
  await waitFor(() => expect(routing.mainExecutions).toEqual(['Text-only main work']));
  expect(routing.mainMessages.find(message => message.role === 'user')?.images).toBeUndefined();
  expect(harness.imageContextManager.getAttachedImages()).toEqual([sideImage]);
});

it.each(['initialization', 'handoff'] as const)('restores a failed main queue to main after %s failure', async failAt => {
  const harness = createHarness();
  const routing = createRouting(harness, {}, failAt);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  harness.inputEl.value = 'Unsent side draft';
  const sideImage = { id: 'side-image', name: 'side.png', mediaType: 'image/png', data: 'c2lkZQ==' };
  harness.imageContextManager.setImages([sideImage]);
  routing.state.queuedMessage = { content: 'Retry this in main', images: undefined };
  routing.controller.resumeQueuedTurnAfterIntentAdmission();
  await waitFor(() => expect(routing.mainMessages.length).toBeGreaterThan(0));
  await waitFor(() => expect(routing.state.isStreaming).toBe(false));
  expect(harness.controller.destination).toBe('side');
  expect(harness.inputEl.value).toBe('Unsent side draft');
  expect(harness.imageContextManager.getAttachedImages()).toEqual([sideImage]);
  harness.controller.collapse();
  expect(harness.inputEl.value).toBe('Retry this in main');
  expect(harness.imageContextManager.getAttachedImages()).toEqual([]);
});

it.each(['initialization', 'missing-coordinator', 'handoff'] as const)(
  'preserves existing main and side drafts when queued main fails at %s', async failAt => {
    const harness = createHarness();
    const routing = createRouting(harness, {}, failAt);
    const { started } = await startSideChat(harness);
    harness.backend.latest.establishChild('child-session');
    harness.backend.latest.complete();
    await started;
    harness.controller.collapse();
    harness.inputEl.value = 'Existing main draft';
    const mainImage = { id: 'main-image', name: 'main.png', mediaType: 'image/png', data: 'bWFpbg==' };
    harness.imageContextManager.setImages([mainImage]);
    harness.controller.expand();
    harness.inputEl.value = 'Unsent side draft';
    const sideImage = { id: 'side-image', name: 'side.png', mediaType: 'image/png', data: 'c2lkZQ==' };
    const queuedImage = { id: 'queued-image', name: 'queued.png', mediaType: 'image/png', data: 'cXVldWVk' };
    harness.imageContextManager.setImages([sideImage]);
    routing.state.queuedMessage = { content: 'Retry main work', images: [queuedImage] };
    routing.controller.resumeQueuedTurnAfterIntentAdmission();
    await waitFor(() => expect(routing.mainMessages.length).toBeGreaterThan(0));
    await waitFor(() => expect(routing.state.isStreaming).toBe(false));
    expect(harness.inputEl.value).toBe('Unsent side draft');
    expect(harness.imageContextManager.getAttachedImages()).toEqual([sideImage]);
    harness.controller.collapse();
    expect(harness.inputEl.value).toBe('Retry main work\n\nExisting main draft');
    expect(harness.imageContextManager.getAttachedImages()).toEqual([queuedImage, mainImage]);
    harness.controller.expand();
    expect(harness.inputEl.value).toBe('Unsent side draft');
    expect(harness.imageContextManager.getAttachedImages()).toEqual([sideImage]);
  },
);

it.each([false, true])('queues collapsed side commands in order with captured input during a later turn=%s', async laterTurn => {
  const harness = createHarness();
  const context: ProviderExecutionContext = {
    canvasSelection: { canvasPath: 'Plan.canvas', nodeIds: ['original-node'] },
  };
  const routing = createRouting(harness, context);
  let { started } = await startSideChat(harness);
  const native = harness.backend.latest;
  native.establishChild('child-session');
  if (laterTurn) {
    native.complete();
    await started;
    started = harness.controller.submitToSide('Ongoing side question', []);
  }
  const initialRequests = laterTurn ? 2 : 1;
  await waitFor(() => expect(native.requests).toHaveLength(initialRequests));
  harness.inputEl.value = 'Unsent side draft';
  harness.controller.collapse();

  const image: ImageAttachment = {
    id: 'queued-image', name: 'queued.png', mediaType: 'image/png',
    data: 'cXVldWVk', size: 6, source: 'paste',
  };
  harness.imageContextManager.setImages([image]);
  harness.inputEl.value = '/side First queued question';
  await routing.controller.sendMessage();
  expect(harness.inputEl.value).toBe('');
  expect(harness.imageContextManager.getAttachedImages()).toEqual([]);
  expect(harness.controller.destination).toBe('main');
  expect(native.requests).toHaveLength(initialRequests);

  image.data = 'changed';
  context.canvasSelection!.nodeIds[0] = 'changed-node';
  harness.inputEl.value = '/btw Second queued question';
  await routing.controller.sendMessage();
  harness.inputEl.value = 'New main draft';
  native.emitText('Original side answer');
  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(initialRequests + 1));
  expect(native.requests[initialRequests].input).toEqual([
    { type: 'text', text: 'First queued question' },
    { type: 'image', image: { ...image, data: 'cXVldWVk' } },
  ]);
  expect(native.requests[initialRequests].context?.canvasSelection?.nodeIds).toEqual(['original-node']);
  expect(native.requests[initialRequests].conversationHistory).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'assistant', content: 'Original side answer' }),
  ]));
  expect(harness.inputEl.value).toBe('New main draft');
  expect(harness.controller.destination).toBe('main');

  native.emitText('First queued answer');
  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(initialRequests + 2));
  expect(native.requests[initialRequests + 1].input).toEqual([{ type: 'text', text: 'Second queued question' }]);
  native.complete();
  await started;
  expect(harness.backend.sessions).toHaveLength(1);
  expect(routing.mainExecutions).toEqual([]);
  expect(routing.state.queuedMessage).toBeNull();
  harness.controller.expand();
  expect(harness.inputEl.value).toBe('Unsent side draft');
});

it.each(['discard', 'cancel', 'replace main'] as const)(
  'clears queued side work on %s without sending it to another destination', async action => {
    const harness = createHarness();
    const routing = createRouting(harness);
    const { started } = await startSideChat(harness);
    const native = harness.backend.latest;
    native.establishChild('child-session');
    harness.controller.collapse();
    harness.inputEl.value = '/side Queued question';
    await routing.controller.sendMessage();
    expect(harness.inputEl.value).toBe('');

    if (action === 'discard') await harness.controller.discard();
    else if (action === 'replace main') harness.controller.handleConversationChanged('replacement');
    else harness.controller.cancelSide();
    await started;
    expect(native.requests).toHaveLength(1);
    expect(routing.mainExecutions).toEqual([]);
    await harness.controller.discard();
    const replacement = harness.controller.handleCommandSubmission('Fresh side', []);
    await waitFor(() => expect(harness.backend.sessions).toHaveLength(2));
    await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(1));
    harness.backend.latest.establishChild('replacement-child');
    harness.backend.latest.complete();
    await replacement;
    expect(harness.backend.latest.requests.map(request => request.input)).toEqual([
      [{ type: 'text', text: 'Fresh side' }],
    ]);
  },
);

it('uses saved native execution when the provider requires persistent forks', async () => {
  const harness = createHarness({ supportsEphemeralFork: false });
  const { started } = await startSideChat(harness);
  expect(harness.backend.latest.config).toMatchObject({
    lifecycle: 'persistent', nativePersistence: 'enabled',
  });
  harness.backend.latest.complete();
  expect(await started).toBe(true);
});

it('uses the captured conversation capabilities for ephemeral side execution', async () => {
  const base = ProviderRegistry.getCapabilities('claude');
  const state = { version: 'supports-ephemeral-forks' };
  const harness = createHarness({
    supportsEphemeralFork: false, providerState: state,
    getConversationCapabilities: providerState => ({ ...base, supportsEphemeralFork: providerState?.version === state.version }),
  });
  const { started } = await startSideChat(harness);
  expect(harness.backend.latest.config).toMatchObject({ lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported' });
  harness.backend.latest.complete();
  expect(await started).toBe(true);
});

it('uses the configured provider environment when preparing the native side fork', async () => {
  let database: string | undefined;
  const harness = createHarness({
    settings: { providerConfigs: { claude: { environmentVariables: 'OPENCODE_DB=/custom/chat.db' } } },
    buildForkProviderState: (_session, _checkpoint, _state, _vault, context, options) => {
      expect(options).toEqual({ lifecycle: 'ephemeral' });
      database = context?.environment.OPENCODE_DB;
      return {};
    },
  });
  const { started } = await startSideChat(harness);
  harness.backend.latest.complete();
  await started;
  expect(database).toBe('/custom/chat.db');
});

it('rejects a full-session side fork when main advances during native preparation', async () => {
  let finishFork: ((state: Record<string, unknown>) => void) | undefined;
  const harness = createHarness({
    forkMode: 'full-session', supportsEphemeralFork: false,
    buildForkProviderState: () => new Promise(resolve => { finishFork = resolve; }),
  });
  const started = harness.controller.handleCommandSubmission('Explore the current reply', []);
  await waitFor(() => expect(finishFork).toBeDefined());
  harness.controller.collapse();
  harness.tab.state.messages.push({ id: 'new-main-question', content: 'Main advances', role: 'user', timestamp: 3 });
  finishFork!({ sessionId: 'native-child' });
  await waitFor(() => expect(harness.controller.runtime?.status === 'error' || harness.backend.sessions.length > 0).toBe(true));
  if (harness.backend.sessions.length > 0) harness.backend.latest.complete();
  await started;
  expect(harness.controller.runtime?.status).toBe('error');
  expect(harness.controller.runtime?.lastError).toMatch(/source.*changed/i);
});


it('protects parked main drafts and cancels branch previews when switching to side chat', async () => {
  const harness = createHarness({ onDestinationChanged: () => {
    if (harness.controller.destination === 'side') conversation.cancelBranchDraft();
  } });
  const routing = createRouting(harness);
  const prompt: ChatMessage = { id: 'second', role: 'user', content: 'Old prompt', timestamp: Date.now(), userMessageId: 'native-second' };
  const history: ChatMessage[] = [{ id: 'first', role: 'user', content: 'First', timestamp: Date.now() }, prompt];
  routing.state.messages = history;
  const conversation = new ConversationController({
    state: routing.state, drafts: harness.drafts, navigation: createConversationPorts(routing.deps as any).navigation, plugin: harness.plugin,
    renderer: { renderMessages: jest.fn(), refreshBranchButtonState: jest.fn() },
    getInputEl: () => harness.inputEl, getMessagesEl: () => document.body,
    getImageContextManager: () => harness.imageContextManager,
    getWelcomeEl: () => null, setWelcomeEl: jest.fn(),
    isMainComposerActive: () => harness.controller.destination === 'main',
  } as any);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  harness.controller.collapse();
  harness.inputEl.value = 'Parked main draft';
  harness.controller.expand();
  await conversation.navigateBranch('second');
  expect(harness.drafts.capture('main').content).toBe('Parked main draft');
  expect(harness.inputEl.value).toBe('');
  harness.inputEl.value = 'Side draft';
  harness.controller.collapse();
  harness.inputEl.value = '';
  await conversation.navigateBranch('second');
  expect(harness.inputEl.value).toBe('Old prompt');
  harness.controller.expand();
  expect(harness.inputEl.value).toBe('Side draft');
  expect(harness.drafts.capture('main').content).toBe('');
  harness.controller.collapse();
  expect(harness.inputEl.value).toBe('');
  expect(routing.state.messages).toEqual(history);
});


it.each([false, true])('keeps side drafts separate while a branch submission settles (cancelled: %s)', async cancelled => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  const sideImage = { id: 'side', name: 'side.png', data: 'side-data', mediaType: 'image/png' } as ImageAttachment;
  const mainImage = { id: 'main', name: 'main.png', data: 'main-data', mediaType: 'image/png' } as ImageAttachment;
  harness.inputEl.value = 'Unsent side draft';
  harness.imageContextManager.setImages([sideImage]);
  harness.controller.collapse();
  const first: ChatMessage = { id: 'first', role: 'user', content: 'First', timestamp: Date.now() };
  const prompt: ChatMessage = { id: 'second', role: 'user', content: 'Original', images: [mainImage], timestamp: Date.now(), userMessageId: 'native-second' };
  routing.state.messages = [first, prompt];
  routing.state.addMessage = message => { routing.mainMessages.push(message); routing.state.messages.push(message); };
  const navigation = deferred<{ status: string; messages: ChatMessage[] }>();
  const coordinator = { navigateConversationBranch: jest.fn().mockReturnValue(navigation.promise) };
  const conversation = new ConversationController({
    ...routing.deps, navigation: createConversationPorts(routing.deps as any).navigation, plugin: { settings: {}, updateConversation: jest.fn() },
    renderer: { renderMessages: jest.fn(), refreshBranchButtonState: jest.fn() },
    setWelcomeEl: jest.fn(), getExecutionCoordinator: () => coordinator,
  } as any);
  routing.deps.conversationController = conversation;
  await conversation.navigateBranch('second');
  harness.inputEl.value = 'Edited main';
  const sending = routing.controller.sendMessage();
  await waitFor(() => expect(coordinator.navigateConversationBranch).toHaveBeenCalled());
  harness.controller.expand();
  conversation.cancelBranchDraft();
  navigation.resolve({ status: cancelled ? 'cancelled' : 'committed', messages: [first] });
  await sending;
  expect(harness.inputEl.value).toBe('Unsent side draft');
  expect(harness.imageContextManager.getAttachedImages()).toEqual([sideImage]);
  expect(routing.mainExecutions).toEqual(cancelled ? [] : ['Edited main']);
  expect(routing.mainMessages.filter(message => message.role === 'user').map(message => message.images)).toEqual(cancelled ? [] : [[mainImage]]);
  expect(harness.drafts.capture('main').content).toBe(cancelled ? 'Edited main' : '');
});

it.each([false, true])('keeps the captured side mention after collapse (cancel main: %s)', async cancelMain => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  const hydration = deferred<any>();
  const entered = deferred<void>();
  const write = jest.fn().mockResolvedValue('/tmp/claudian-sessions/side.md');
  Object.assign(routing.deps.plugin, {
    getConversationById: () => { entered.resolve(); return hydration.promise; },
    findConversationAcrossViews: () => null,
    writeSessionSnapshot: write,
  });
  harness.inputEl.value = '@[Old](claudian-session:conv-1-source)';
  const sending = routing.controller.sendMessage();
  await entered.promise;
  harness.controller.collapse();
  if (cancelMain) {
    routing.state.isStreaming = true;
    routing.controller.cancelStreaming();
  }
  harness.inputEl.value = 'new main draft';
  hydration.resolve({
    id: 'conv-1-source', title: 'Renamed', providerId: 'codex', createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
    messages: [{ id: 'u', role: 'user', content: 'source prompt', timestamp: testDate().getTime() }],
  });
  await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(2));
  expect(harness.backend.latest.requests[1]).toMatchObject({
    input: [{ type: 'text', text: '@"Renamed"' }],
    context: { sessionReferences: [{ id: 'conv-1-source', snapshotPath: '/tmp/claudian-sessions/side.md' }] },
    configuration: { readableRoots: ['/tmp/claudian-sessions'] },
  });
  expect(harness.controller.runtime?.state.messages.find(message => message.content === '@"Renamed"')?.displayContent).toBe('@"Renamed"');
  harness.backend.latest.complete();
  await sending;
  expect(routing.mainExecutions).toEqual(cancelMain ? ['<cancelled>'] : []);
  expect(harness.inputEl.value).toBe('new main draft');
});

it('shows side preparation as working and cancels it through the selected destination control', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  const hydration = deferred<any>();
  const entered = deferred<void>();
  Object.assign(routing.deps.plugin, { getConversationById: () => { entered.resolve(); return hydration.promise; } });
  const token = '@[Old](claudian-session:conv-1-source)';
  harness.inputEl.value = token;
  const sending = routing.controller.sendMessage();
  await entered.promise;
  expect(harness.controller.runtime?.isWorking).toBe(true);
  expect(cancelSelectedDestinationTurn(routing.tab)).toBe(true);
  hydration.resolve(null);
  await sending;
  expect(harness.backend.latest.requests).toHaveLength(1);
  expect(harness.inputEl.value).toBe(token);
});

it('runs a queued side command after mention preparation fails', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('child-session');
  harness.backend.latest.complete();
  await started;
  const hydration = deferred<any>();
  const entered = deferred<void>();
  Object.assign(routing.deps.plugin, { getConversationById: () => { entered.resolve(); return hydration.promise; } });
  const token = '@[Old](claudian-session:conv-1-source)';
  harness.inputEl.value = token;
  const sending = routing.controller.sendMessage();
  await entered.promise;
  harness.controller.collapse();
  harness.inputEl.value = '/btw Later side question';
  await routing.controller.sendMessage();
  expect(harness.controller.runtime?.queuedCount).toBe(1);
  hydration.resolve(null);
  await sending;
  await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(2));
  expect(harness.backend.latest.requests[1].input).toEqual([{ type: 'text', text: 'Later side question' }]);
  expect(harness.controller.runtime?.queuedCount).toBe(0);
  expect(harness.drafts.capture('side').content).toBe(token);
  harness.backend.latest.complete();
});

it.each(['side', 'btw'].flatMap(command => ['new', 'collapsed', 'queued'].map(mode => ({ command, mode }))))('resolves mentions in /$command ($mode)', async ({ command, mode }) => {
  const harness = createHarness();
  const routing = createRouting(harness);
  let active: Promise<unknown> | undefined;
  if (mode !== 'new') {
    const result = await startSideChat(harness);
    active = result.started;
    harness.backend.latest.establishChild('child-session');
    if (mode === 'collapsed') {
      harness.backend.latest.complete();
      await active;
    }
    harness.controller.collapse();
  }
  const token = '@[Old](claudian-session:conv-1-source)';
  const write = jest.fn().mockResolvedValue('/tmp/claudian-sessions/side.md');
  Object.assign(routing.deps.plugin, {
    getConversationById: async () => ({
      id: 'conv-1-source', title: 'Renamed', providerId: 'codex', createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
      messages: [{ id: 'u', role: 'user', content: 'source prompt', timestamp: testDate().getTime() }],
    }),
    findConversationAcrossViews: () => null,
    writeSessionSnapshot: write,
  });
  harness.inputEl.value = `/${command} Use ${token}`;
  const sending = routing.controller.sendMessage();
  if (mode === 'queued') {
    await sending;
    harness.backend.latest.complete();
  }
  await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(mode === 'new' ? 1 : 2));
  const request = harness.backend.latest.requests.at(-1)!;
  harness.backend.latest.complete();
  await Promise.all([sending, active]);
  expect({ input: request.input, references: request.context?.sessionReferences?.map(value => value.id) ?? [], snapshots: write.mock.calls.length })
    .toEqual({ input: [{ type: 'text', text: 'Use @"Renamed"' }], references: ['conv-1-source'], snapshots: 1 });
});


it('reserves command order and snapshots queued mentions before the child becomes idle', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;
  native.establishChild('child-session');
  harness.controller.collapse();
  const hydration = deferred<any>();
  const entered = jest.fn();
  const write = jest.fn().mockResolvedValue('/tmp/claudian-sessions/queued.md');
  Object.assign(harness.plugin, {
    getConversationById: () => { entered(); return hydration.promise; },
    findConversationAcrossViews: () => null,
    writeSessionSnapshot: write,
  });
  harness.inputEl.value = '/side First @[Old](claudian-session:conv-1-source)';
  const first = routing.controller.sendMessage();
  await waitFor(() => expect(harness.controller.runtime?.queuedCount).toBe(1));
  // Hydration must begin at admission, while the current side turn is still active.
  expect(entered).toHaveBeenCalledTimes(1);
  harness.inputEl.value = '/btw Second';
  await routing.controller.sendMessage();
  expect(harness.controller.runtime?.queuedCount).toBe(2);
  native.complete();
  hydration.resolve({
    id: 'conv-1-source', title: 'Captured', providerId: 'codex', createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
    messages: [{ id: 'u', role: 'user', content: 'source prompt', timestamp: testDate().getTime() }],
  });
  await first;
  await waitFor(() => expect(native.requests).toHaveLength(2));
  expect(native.requests[1].input).toEqual([{ type: 'text', text: 'First @"Captured"' }]);
  expect(write).toHaveBeenCalledTimes(1);
  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(3));
  expect(native.requests[2].input).toEqual([{ type: 'text', text: 'Second' }]);
  native.complete();
  await started;
});

it.each(['failure', 'cancel', 'dispose'])('restores a queued command and attachments after preparation %s', async mode => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;
  native.establishChild('child-session');
  harness.controller.collapse();
  const hydration = deferred<any>();
  const entered = jest.fn();
  Object.assign(harness.plugin, { getConversationById: () => { entered(); return hydration.promise; } });
  const command = '/btw Use @[Old](claudian-session:conv-1-source)';
  const attachment = { id: 'image-1', data: 'aW1hZ2U=', mediaType: 'image/png', name: 'image.png' };
  harness.imageContextManager.setImages([attachment]);
  harness.inputEl.value = command;
  const sending = routing.controller.sendMessage();
  await waitFor(() => expect(harness.controller.runtime?.queuedCount).toBe(1));
  expect(entered).toHaveBeenCalledTimes(1);
  harness.inputEl.value = 'Later main draft';
  let disposed = false;
  const disposal = mode === 'dispose' ? harness.controller.discard().then(() => { disposed = true; }) : null;
  if (mode === 'cancel') harness.controller.cancelSide();
  await Promise.resolve();
  expect(disposed).toBe(false);
  const cancellationsBeforeHydration = native.cancelCalls;
  hydration.resolve(null);
  await Promise.all([sending, disposal]);
  await waitFor(() => expect(harness.drafts.capture('main').content).toContain(command));
  expect(harness.drafts.capture('main').content).toContain('Later main draft');
  expect(harness.drafts.capture('main').images).toEqual([attachment]);
  expect(native.requests).toHaveLength(1);
  if (mode === 'failure') native.complete();
  await started;
  expect(cancellationsBeforeHydration).toBe(mode === 'failure' ? 0 : 1);
  expect(harness.drafts.capture('main').content.split(command)).toHaveLength(2);
});

it('joins a starting command on disposal before fork capture or hydration settles', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const capture = deferred<{ resumeAt: string; sessionId: string }>();
  const hydration = deferred<any>();
  harness.tab.executionCoordinator.resolveForkSource = () => capture.promise;
  Object.assign(harness.plugin, { getConversationById: () => hydration.promise });
  const command = '/side Use @[Old](claudian-session:conv-1-source)';
  harness.inputEl.value = command;
  const sending = routing.controller.sendMessage();
  let disposed = false;
  const disposal = harness.controller.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  expect(disposed).toBe(false);
  capture.resolve({ resumeAt: 'checkpoint-1', sessionId: 'main-session' });
  await Promise.resolve();
  expect(disposed).toBe(false);
  hydration.resolve(null);
  await Promise.all([sending, disposal]);
  expect(disposed).toBe(true);
  expect(harness.backend.sessions).toHaveLength(0);
  expect(harness.inputEl.value).toBe(command);
});

it('retains later main input while a new command captures its source', async () => {
  const harness = createHarness();
  const routing = createRouting(harness);
  const capture = deferred<{ resumeAt: string; sessionId: string }>();
  harness.tab.executionCoordinator.resolveForkSource = () => capture.promise;
  harness.inputEl.value = '/side First question';
  const sending = routing.controller.sendMessage();
  harness.inputEl.value = '/btw Later unsent question';
  capture.resolve({ resumeAt: 'checkpoint-1', sessionId: 'main-session' });
  await waitFor(() => expect(harness.backend.sessions).toHaveLength(1));
  harness.backend.latest.complete();
  await sending;
  expect(harness.drafts.capture('main').content).toBe('/btw Later unsent question');
});
