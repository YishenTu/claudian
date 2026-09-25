/** @jest-environment jsdom */
import '@/providers';

import { waitFor } from '@testing-library/dom';

import type { ProviderExecutionContext } from '@/core/execution';
import type { ChatMessage, ImageAttachment } from '@/core/types';
import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';
import { ChatExecutionPreHandoffError } from '@/features/chat/execution/ChatExecutionCoordinator';
import { cancelSelectedDestinationTurn } from '@/features/chat/tabs/TabInputEvents';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

import {
  createHarness,
  releaseSideChatHarnesses,
  type SideChatDOMHarness,
  startSideChat,
} from './SideChatDOMHarness';

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
    hasPendingConversationSave: false,
    isStreaming: false,
    isSwitchingConversation: false,
    messages: [],
    responseStartTime: null,
    streamGeneration: 1,
    queuedMessage: null as unknown,
    queueIndicatorEl: null,
  };
  const controller = new InputController({
    getSettings: () => ({ model: 'claude-model', reasoning: 'high', permissionMode: 'normal', serviceTier: 'default' }),
    canvasSelectionController: { getContext: () => context.canvasSelection ?? null },
    browserSelectionController: { getContext: () => context.browserSelection ?? null },
    conversationController: { save: async () => undefined },
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
    plugin: { settings: {} },
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
  } as unknown as InputControllerDeps);

  const tab = {
    controllers: { inputController: controller, sideChatController: harness.controller },
    state,
  } as unknown as AssembledTabRuntime;
  return { controller, mainExecutions, mainMessages, state, tab };
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

it('uses the configured provider environment when preparing the native side fork', async () => {
  let database: string | undefined;
  const harness = createHarness({
    settings: { providerConfigs: { claude: { environmentVariables: 'OPENCODE_DB=/custom/chat.db' } } },
    buildForkProviderState: (_session, _checkpoint, _state, _vault, context) => {
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
