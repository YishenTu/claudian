import type {
  ProviderApprovalInteractionRequest,
  ProviderInteractionPort,
  ProviderQuestionInteractionRequest,
  ProviderQuestionInteractionResponse,
  ProviderToolPolicy,
} from '@/core/execution';
import { setLocale } from '@/i18n/i18n';
import { CodexExecutionServerRequestRouter } from '@/providers/codex/execution/CodexExecutionServerRequestRouter';
import { CodexDynamicToolRegistry } from '@/providers/codex/runtime/CodexDynamicToolRegistry';
import { createCodexSessionTools } from '@/providers/codex/runtime/CodexSessionTools';

const confirmationRequest = {
  threadId: 'thread-confirmation',
  turnId: 'turn-confirmation',
  serverName: 'cua_repl',
  mode: 'form',
  message: 'Allow Computer Use to use "Obsidian"?',
  requestedSchema: { type: 'object', properties: {} },
};

function createRouter(
  askUserQuestion: ProviderInteractionPort['askUserQuestion'],
  toolPolicy: ProviderToolPolicy = { kind: 'provider-default' },
  dismissInteraction: ProviderInteractionPort['dismissInteraction'] = () => undefined,
) {
  const router = new CodexExecutionServerRequestRouter(
    'session-confirmation',
    {
      askUserQuestion,
      requestApproval: async () => {
        throw new Error('MCP confirmation must use an explicit question');
      },
      dismissInteraction,
    },
    (threadId, turnId) => threadId === 'thread-confirmation' && turnId === 'turn-confirmation',
  );
  router.setActiveTurn({
    cancellation: new AbortController(),
    localTurnId: 'local-turn',
    nativeThreadId: 'thread-confirmation',
    nativeTurnId: 'turn-confirmation',
    toolPolicy,
  });
  return router;
}

function createPendingQuestion() {
  let resolve!: (response: ProviderQuestionInteractionResponse) => void;
  const response = new Promise<ProviderQuestionInteractionResponse>(nextResolve => {
    resolve = nextResolve;
  });
  const askUserQuestion = vi.fn((_request: ProviderQuestionInteractionRequest, _signal: AbortSignal) => response);
  return { askUserQuestion, resolve };
}

describe('CodexExecutionServerRequestRouter', () => {
  afterEach(() => setLocale('en'));

  it.each(['claudian_list_destinations', 'claudian_sessions.claudian_list_destinations'])(
    'denies session tools even when the allow-list names %s, while ordinary named tools still work', async name => {
      const port = { list: vi.fn(async () => ({ sessions: [] })), send: vi.fn(), read: vi.fn() };
      const router = createRouter(vi.fn(), { kind: 'allow-list', names: [name, 'ordinary'] });
      const registry = new CodexDynamicToolRegistry();
      for (const registration of createCodexSessionTools(port)) registry.register(registration);
      registry.register({ includeInThreadStart: true, tool: { type: 'function', name: 'ordinary', description: '', inputSchema: {} }, handler: async () => ({ success: true, contentItems: [] }) });
      router.setDynamicToolRegistry(registry);
      const params = { threadId: 'thread-confirmation', turnId: 'turn-confirmation', callId: 'call', arguments: {} };
      await expect(router.handleServerRequest('session', 'item/tool/call', { ...params, namespace: 'claudian_sessions', tool: 'claudian_list_destinations' })).resolves.toMatchObject({ success: false });
      expect(port.list).not.toHaveBeenCalled();
      await expect(router.handleServerRequest('ordinary', 'item/tool/call', { ...params, namespace: null, tool: 'ordinary' })).resolves.toMatchObject({ success: true });
    },
  );

  it('requires an explicit answer for the captured Computer Use confirmation, even with unrestricted tools', async () => {
    const askUserQuestion = vi.fn(async (request: ProviderQuestionInteractionRequest) => ({
      interactionId: request.interactionId,
      answers: { 'mcp-elicitation-confirmation': 'accept' },
    }));
    const interactionPort: ProviderInteractionPort = {
      askUserQuestion,
      requestApproval: async () => {
        throw new Error('MCP confirmation must use an explicit question');
      },
      dismissInteraction: () => undefined,
    };
    const router = new CodexExecutionServerRequestRouter(
      'session-confirmation',
      interactionPort,
      (threadId, turnId) => threadId === 'thread-confirmation' && turnId === 'turn-confirmation',
    );
    router.setActiveTurn({
    cancellation: new AbortController(),
      localTurnId: 'local-turn',
      nativeThreadId: 'thread-confirmation',
      nativeTurnId: 'turn-confirmation',
      toolPolicy: { kind: 'unrestricted' },
    });

    // Captured app-server payload, with native identities replaced by test values.
    await expect(router.handleServerRequest(
      'request-confirmation',
      'mcpServer/elicitation/request',
      {
        threadId: 'thread-confirmation',
        turnId: 'turn-confirmation',
        serverName: 'cua_repl',
        mode: 'form',
        message: 'Allow Computer Use to use "Obsidian"?',
        requestedSchema: { type: 'object', properties: {} },
      },
    )).resolves.toEqual({ action: 'accept', content: {} });

    expect(askUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionInstanceId: 'session-confirmation',
        turnId: 'local-turn',
        kind: 'question',
        input: {
          questions: [expect.objectContaining({
            id: 'mcp-elicitation-confirmation',
            question: expect.stringContaining('Allow Computer Use to use "Obsidian"?'),
            isOther: false,
            options: expect.arrayContaining([
              expect.objectContaining({ value: 'accept' }),
              expect.objectContaining({ value: 'decline' }),
              expect.objectContaining({ value: 'cancel' }),
            ]),
          })],
        },
      }),
      expect.any(AbortSignal),
    );
  });

  it.each(['en', 'zh-CN'] as const)('leaves localized confirmation pending until the user explicitly submits a choice (%s)', async locale => {
    setLocale(locale);
    const question = createPendingQuestion();
    const router = createRouter(question.askUserQuestion, { kind: 'unrestricted' });
    const result = router.handleServerRequest('pending', 'mcpServer/elicitation/request', confirmationRequest);
    const [request] = question.askUserQuestion.mock.calls[0];
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(request.input).toMatchObject({
      questions: [{
        question: `${locale === 'en' ? 'MCP server:' : 'MCP 服务器：'} cua_repl\n\nAllow Computer Use to use "Obsidian"?`,
        multiSelect: false,
        isOther: false,
        options: [
          expect.objectContaining({ value: 'cancel', label: locale === 'en' ? 'Cancel' : '取消' }),
          expect.objectContaining({ value: 'decline', label: locale === 'en' ? 'Decline' : '拒绝' }),
          expect.objectContaining({ value: 'accept', label: locale === 'en' ? 'Allow' : '允许' }),
        ],
      }],
    });
    question.resolve({
      interactionId: request.interactionId,
      answers: { 'mcp-elicitation-confirmation': 'accept' },
    });
    await expect(result).resolves.toEqual({ action: 'accept', content: {} });
  });

  it.each(['form', 'openai/form'])('accepts an explicitly answered %s confirmation without echoing server metadata', async mode => {
    const router = createRouter(async request => ({
      interactionId: request.interactionId,
      answers: { 'mcp-elicitation-confirmation': 'accept' },
    }));
    await expect(router.handleServerRequest('form', 'mcpServer/elicitation/request', {
      ...confirmationRequest,
      mode,
      _meta: { persist: ['session', 'always'] },
      requestedSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    })).resolves.toEqual({ action: 'accept', content: {} });
  });

  it.each([
    ['decline', { 'mcp-elicitation-confirmation': 'decline' }, 'decline'],
    ['cancel', { 'mcp-elicitation-confirmation': 'cancel' }, 'cancel'],
    ['dismissed', null, 'cancel'],
    ['empty', {}, 'cancel'],
    ['blank', { 'mcp-elicitation-confirmation': '' }, 'cancel'],
    ['label instead of value', { 'mcp-elicitation-confirmation': 'Allow' }, 'cancel'],
    ['free text', { 'mcp-elicitation-confirmation': 'yes please' }, 'cancel'],
    ['array', { 'mcp-elicitation-confirmation': ['accept'] }, 'cancel'],
    ['multiple choices', { 'mcp-elicitation-confirmation': ['accept', 'decline'] }, 'cancel'],
    ['wrong question', { other: 'accept' }, 'cancel'],
    ['extra answers', { 'mcp-elicitation-confirmation': 'accept', other: 'value' }, 'cancel'],
  ] as const)('does not grant access for a %s answer', async (_name, answers, action) => {
    const router = createRouter(async request => ({
      interactionId: request.interactionId,
      answers: answers as ProviderQuestionInteractionResponse['answers'],
    }));
    await expect(router.handleServerRequest('answer', 'mcpServer/elicitation/request', confirmationRequest))
      .resolves.toEqual({ action, content: null });
  });

  it('never dismisses a confirmation the user already answered', async () => {
    const dismissInteraction = vi.fn();
    const router = createRouter(async request => ({
      interactionId: request.interactionId,
      answers: { 'mcp-elicitation-confirmation': 'accept' },
    }), undefined, dismissInteraction);
    await expect(router.handleServerRequest('answered', 'mcpServer/elicitation/request', confirmationRequest))
      .resolves.toEqual({ action: 'accept', content: {} });

    expect(router.resolveNativeRequest('answered', 'thread-confirmation')).toBe(false);
    router.abortAll('resolved');
    expect(dismissInteraction).not.toHaveBeenCalled();
  });

  it('cancels a response for another interaction', async () => {
    const router = createRouter(async () => ({
      interactionId: 'another-interaction',
      answers: { 'mcp-elicitation-confirmation': 'accept' },
    }));
    await expect(router.handleServerRequest('identity', 'mcpServer/elicitation/request', confirmationRequest))
      .resolves.toEqual({ action: 'cancel', content: null });
  });

  it.each(['abort', 'native resolution', 'turn replacement'])('rejects a late accepting answer after %s', async invalidation => {
    const question = createPendingQuestion();
    const router = createRouter(question.askUserQuestion);
    const result = router.handleServerRequest('stale', 'mcpServer/elicitation/request', confirmationRequest);
    const [request, signal] = question.askUserQuestion.mock.calls[0];
    if (invalidation === 'abort') router.abortAll('cancelled');
    else if (invalidation === 'native resolution') router.resolveNativeRequest('stale', 'thread-confirmation');
    else router.setActiveTurn({
    cancellation: new AbortController(),
      localTurnId: 'different-local-turn',
      nativeThreadId: 'thread-confirmation',
      nativeTurnId: 'different-native-turn',
      toolPolicy: { kind: 'provider-default' },
    });
    expect(signal.aborted).toBe(invalidation !== 'turn replacement');
    question.resolve({
      interactionId: request.interactionId,
      answers: { 'mcp-elicitation-confirmation': 'accept' },
    });
    await expect(result).resolves.toEqual({ action: 'cancel', content: null });
    expect(router.resolveNativeRequest('stale', 'thread-confirmation')).toBe(false);
  });

  it('does not resolve a confirmation using another native thread identity', async () => {
    const question = createPendingQuestion();
    const router = createRouter(question.askUserQuestion);
    const result = router.handleServerRequest('thread-scoped', 'mcpServer/elicitation/request', confirmationRequest);
    const [request, signal] = question.askUserQuestion.mock.calls[0];
    expect(router.resolveNativeRequest('thread-scoped', 'another-thread')).toBe(false);
    expect(signal.aborted).toBe(false);
    question.resolve({ interactionId: request.interactionId, answers: null });
    await expect(result).resolves.toEqual({ action: 'cancel', content: null });
  });

  it.each([
    { threadId: 'another-thread' },
    { turnId: 'another-turn' },
    { turnId: null },
    { turnId: '' },
    { serverName: '' },
    { message: null },
    { mode: 'unknown' },
  ])('cancels malformed or unowned confirmation %j without asking', async fields => {
    const askUserQuestion = vi.fn(async () => { throw new Error('This request must not reach the user'); });
    const router = createRouter(askUserQuestion);
    await expect(router.handleServerRequest('unowned', 'mcpServer/elicitation/request', {
      ...confirmationRequest, ...fields,
    })).resolves.toEqual({ action: 'cancel', content: null });
    expect(askUserQuestion).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'object', properties: { permission: { type: 'boolean' } } },
    { type: 'object', properties: {}, required: ['permission'] },
    { type: 'object', properties: {}, required: 'permission' },
    { type: 'object', properties: {}, minProperties: 1 },
    { type: 'object', properties: {}, additionalProperties: { type: 'string' } },
    { type: 'object', properties: {}, allOf: [] },
    { type: 'object', properties: {}, title: 'An unsupported schema annotation' },
    { type: 'object', properties: [] },
    { type: 'array', properties: {} },
    { type: 'object' },
    Object.assign(Object.create({ inherited: true }), { type: 'object', properties: {} }),
    null,
  ])('declines unsupported schema %j without asking', async requestedSchema => {
    const router = createRouter(async () => { throw new Error('This schema must not reach the user'); });
    await expect(router.handleServerRequest('unsupported', 'mcpServer/elicitation/request', {
      ...confirmationRequest, requestedSchema,
    })).resolves.toEqual({ action: 'decline', content: null });
  });

  it('declines unsupported URL elicitation without opening or approving it', async () => {
    const router = createRouter(async () => { throw new Error('This URL must not reach the user'); });
    await expect(router.handleServerRequest('url', 'mcpServer/elicitation/request', {
      ...confirmationRequest,
      mode: 'url',
      url: 'https://example.invalid/approve',
      elicitationId: 'url-approval',
    })).resolves.toEqual({ action: 'decline', content: null });
  });

  it('declines confirmation for an execution that cannot request interactions', async () => {
    const router = createRouter(async () => { throw new Error('This execution must not ask'); }, { kind: 'passive' });
    await expect(router.handleServerRequest('policy', 'mcpServer/elicitation/request', confirmationRequest))
      .resolves.toEqual({ action: 'decline', content: null });
  });

  it('cancels a failed user interaction and releases the pending native request', async () => {
    const router = createRouter(async () => { throw new Error('Interaction closed'); });
    await expect(router.handleServerRequest('failed', 'mcpServer/elicitation/request', confirmationRequest))
      .resolves.toEqual({ action: 'cancel', content: null });
    expect(router.resolveNativeRequest('failed', 'thread-confirmation')).toBe(false);
  });

  it('wraps a literal own __proto__ user-input answer as an own key through serialization', async () => {
    const router = createRouter(async request => ({
      interactionId: request.interactionId,
      answers: JSON.parse('{"__proto__":"Blue"}') as ProviderQuestionInteractionResponse['answers'],
    }));
    await expect(router.handleServerRequest('own-proto', 'item/tool/requestUserInput', {
      threadId: 'thread-confirmation',
      turnId: 'turn-confirmation',
      itemId: 'question-item',
      questions: JSON.parse('[{"id":"__proto__","header":"Color?","question":"Color?","options":null,"isOther":false,"isSecret":false}]'),
    })).resolves.toEqual(JSON.parse('{"answers":{"__proto__":{"answers":["Blue"]}}}'));

    const wrapped = createRouter(async request => ({
      interactionId: request.interactionId,
      answers: JSON.parse('{"__proto__":["Blue",""]}') as ProviderQuestionInteractionResponse['answers'],
    }));
    const result = await wrapped.handleServerRequest('own-proto-array', 'item/tool/requestUserInput', {
      threadId: 'thread-confirmation',
      turnId: 'turn-confirmation',
      itemId: 'question-item',
      questions: [],
    });
    expect(Object.hasOwn((result as { answers: object }).answers, '__proto__')).toBe(true);
    expect(JSON.stringify(result)).toBe('{"answers":{"__proto__":{"answers":["Blue"]}}}');
  });

  it('keeps user-input blank filtering and empty envelopes while rejecting mismatched interactions', async () => {
    const router = createRouter(async request => ({
      interactionId: request.interactionId,
      answers: JSON.parse('{"color":["","  ","Blue"],"blank":"   "}') as ProviderQuestionInteractionResponse['answers'],
    }));
    await expect(router.handleServerRequest('filtered', 'item/tool/requestUserInput', {
      threadId: 'thread-confirmation',
      turnId: 'turn-confirmation',
      itemId: 'question-item',
      questions: [],
    })).resolves.toEqual(JSON.parse('{"answers":{"color":{"answers":["Blue"]},"blank":{"answers":[]}}}'));

    const empty = createRouter(async request => ({ interactionId: request.interactionId, answers: {} }));
    await expect(empty.handleServerRequest('empty', 'item/tool/requestUserInput', {
      threadId: 'thread-confirmation',
      turnId: 'turn-confirmation',
      itemId: 'question-item',
      questions: [],
    })).resolves.toEqual({ answers: {} });

    const mismatched = createRouter(async () => ({ interactionId: 'another-interaction', answers: JSON.parse('{"color":"Blue"}') as ProviderQuestionInteractionResponse['answers'] }));
    await expect(mismatched.handleServerRequest('mismatch', 'item/tool/requestUserInput', {
      threadId: 'thread-confirmation',
      turnId: 'turn-confirmation',
      itemId: 'question-item',
      questions: [],
    })).resolves.toEqual({ answers: {} });

    const dismissed = createRouter(async request => ({ interactionId: request.interactionId, answers: null }));
    await expect(dismissed.handleServerRequest('dismissed', 'item/tool/requestUserInput', {
      threadId: 'thread-confirmation',
      turnId: 'turn-confirmation',
      itemId: 'question-item',
      questions: [],
    })).resolves.toEqual({ answers: {} });
  });
});


it('localizes Codex command approval labels without changing native decisions', async () => {
  setLocale('zh-CN');
  const requestApproval = vi.fn(async (request: ProviderApprovalInteractionRequest) => ({
    interactionId: request.interactionId, decision: 'allow' as const,
  }));
  const router = new CodexExecutionServerRequestRouter('session-confirmation', {
    requestApproval,
    askUserQuestion: async request => ({ interactionId: request.interactionId, answers: {} }),
    dismissInteraction: () => undefined,
  }, () => true);
  router.setActiveTurn({ localTurnId: 'local-turn', nativeThreadId: 'thread-confirmation', nativeTurnId: 'turn-confirmation', toolPolicy: { kind: 'provider-default' }, cancellation: new AbortController() });
  try {
    await expect(router.handleServerRequest('command', 'item/commandExecution/requestApproval', {
      threadId: 'thread-confirmation', turnId: 'turn-confirmation', itemId: 'command-item', command: 'npm test',
    })).resolves.toEqual({ decision: 'accept' });
    const [request] = requestApproval.mock.calls[0];
    expect(request.description).toBe('执行：npm test');
    expect(request.decisionOptions?.map(option => [option.label, option.value])).toEqual([
      ['允许一次', 'allow-once'], ['始终允许', 'allow-always'], ['拒绝', 'deny'],
    ]);
  } finally {
    setLocale('en');
  }
});
