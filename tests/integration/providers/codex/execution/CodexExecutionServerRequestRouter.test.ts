import type {
  ProviderApprovalDecisionOption,
  ProviderApprovalInteractionRequest,
  ProviderInteractionPort,
  ProviderQuestionInteractionRequest,
  ProviderQuestionInteractionResponse,
  ProviderToolPolicy,
} from '@/core/execution';
import { setLocale, t } from '@/i18n/i18n';
import { type ActiveInteractionTurn, CodexExecutionServerRequestRouter } from '@/providers/codex/execution/CodexExecutionServerRequestRouter';
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
  turn: { current: ActiveInteractionTurn | null } = { current: null },
) {
  turn.current ??= {
    cancellation: new AbortController(),
    localTurnId: 'local-turn',
    nativeThreadId: 'thread-confirmation',
    nativeTurnId: 'turn-confirmation',
    toolPolicy,
  };
  return new CodexExecutionServerRequestRouter(
    'session-confirmation',
    {
      askUserQuestion,
      requestApproval: async () => {
        throw new Error('MCP confirmation must use an explicit question');
      },
      dismissInteraction,
    },
    (threadId, turnId) => threadId === 'thread-confirmation' && turnId === 'turn-confirmation',
    () => turn.current,
  );
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

  it.each(['provider-default', 'passive', 'read-only'] as const)(
    'checks the %s policy when a session or ordinary dynamic tool is called', async kind => {
      const port = { list: vi.fn(async () => ({ sessions: [] })), send: vi.fn(), read: vi.fn() };
      const ordinary = vi.fn(async () => ({ success: true, contentItems: [] }));
      const router = createRouter(vi.fn(), { kind });
      const registry = new CodexDynamicToolRegistry();
      for (const registration of createCodexSessionTools(port)) registry.register(registration);
      registry.register({ includeInThreadStart: true, tool: { type: 'function', name: 'ordinary', description: '', inputSchema: {} }, handler: ordinary });
      router.setDynamicToolRegistry(registry);
      const params = { threadId: 'thread-confirmation', turnId: 'turn-confirmation', callId: 'call', arguments: {} };
      const allowed = kind === 'provider-default';
      await expect(router.handleServerRequest('session', 'item/tool/call', { ...params, namespace: 'claudian_sessions', tool: 'claudian_list_destinations' })).resolves.toMatchObject({ success: allowed });
      expect(port.list).toHaveBeenCalledTimes(allowed ? 1 : 0);
      const ordinaryCall = await router.handleServerRequest('ordinary', 'item/tool/call', { ...params, namespace: null, tool: 'ordinary' })
        .catch((error: unknown) => error instanceof Error ? error.message : error);
      expect(ordinaryCall).toEqual(allowed ? { success: true, contentItems: [] } : 'Unsupported dynamic tool: ordinary');
      expect(ordinary).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it('requires an explicit answer for the captured Computer Use confirmation', async () => {
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
      () => activeTurn,
    );
    const activeTurn: ActiveInteractionTurn = {
      cancellation: new AbortController(),
      localTurnId: 'local-turn',
      nativeThreadId: 'thread-confirmation',
      nativeTurnId: 'turn-confirmation',
      toolPolicy: { kind: 'provider-default' },
    };

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
    setLocale('en');
    const englishServerLabel = t('chat.approval.mcpServer', { server: 'cua_repl' });
    setLocale(locale);
    const serverLabel = t('chat.approval.mcpServer', { server: 'cua_repl' });
    expect(serverLabel !== englishServerLabel).toBe(locale !== 'en');
    const question = createPendingQuestion();
    const router = createRouter(question.askUserQuestion);
    const result = router.handleServerRequest('pending', 'mcpServer/elicitation/request', confirmationRequest);
    const [request] = question.askUserQuestion.mock.calls[0];
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(request.input).toMatchObject({
      questions: [{
        question: `${serverLabel}\n\nAllow Computer Use to use "Obsidian"?`,
        multiSelect: false,
        isOther: false,
        options: [
          expect.objectContaining({ value: 'cancel', label: t('common.cancel') }),
          expect.objectContaining({ value: 'decline', label: t('chat.approval.decline') }),
          expect.objectContaining({ value: 'accept', label: t('chat.approval.allow') }),
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
    const turn: { current: ActiveInteractionTurn | null } = { current: null };
    const router = createRouter(question.askUserQuestion, undefined, undefined, turn);
    const result = router.handleServerRequest('stale', 'mcpServer/elicitation/request', confirmationRequest);
    const [request, signal] = question.askUserQuestion.mock.calls[0];
    if (invalidation === 'abort') router.abortAll('cancelled');
    else if (invalidation === 'native resolution') router.resolveNativeRequest('stale', 'thread-confirmation');
    else turn.current = {
      cancellation: new AbortController(),
      localTurnId: 'different-local-turn',
      nativeThreadId: 'thread-confirmation',
      nativeTurnId: 'different-native-turn',
      toolPolicy: { kind: 'provider-default' },
    };
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


const approvalScope = { threadId: 'thread-confirmation', turnId: 'turn-confirmation' };
// Token boundaries matter: a rule for `npm run 'build docs'` differs from one for `npm run build docs`.
const execPolicyAmendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'run', 'build docs'] } };
const networkAmendment = {
  applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'registry.npmjs.org', action: 'deny' as const } },
};
const requestedPermissions = { network: { enabled: true }, fileSystem: { read: null, write: ['/tmp/out'] } };
const allowExampleAmendment = {
  applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' as const } },
};
/** Codex 0.171 sandbox entries: legacy and entry paths overlap, deny entries grant nothing, and disabled network is not access. */
const entryPermissions = {
  network: { enabled: false },
  fileSystem: {
    read: ['/vault/notes'],
    write: null,
    entries: [
      { path: { type: 'path', path: '/vault/notes' }, access: 'read' },
      { path: { type: 'glob_pattern', pattern: '**/*.md' }, access: 'read' },
      { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
      { path: { type: 'special', value: { kind: 'minimal' } }, access: 'read' },
      { path: { type: 'special', value: { kind: 'project_roots', subpath: null } }, access: 'read' },
      { path: { type: 'special', value: { kind: 'unknown', path: ':future', subpath: 'docs' } }, access: 'read' },
      { path: { type: 'special', value: { kind: 'project_roots', subpath: 'build' } }, access: 'write' },
      { path: { type: 'special', value: { kind: 'tmpdir' } }, access: 'write' },
      { path: { type: 'special', value: { kind: 'slash_tmp' } }, access: 'write' },
      { path: { type: 'path', path: '/vault/.secrets' }, access: 'deny' },
    ],
  },
};

function createApprovalRouter(answer: (request: ProviderApprovalInteractionRequest) => string | null) {
  const offered: ProviderApprovalInteractionRequest[] = [];
  const activeTurn: ActiveInteractionTurn = { localTurnId: 'local-turn', nativeThreadId: 'thread-confirmation', nativeTurnId: 'turn-confirmation', toolPolicy: { kind: 'provider-default' }, cancellation: new AbortController() };
  const router = new CodexExecutionServerRequestRouter('session-confirmation', {
    requestApproval: async request => {
      offered.push(request);
      return { interactionId: request.interactionId, value: answer(request) };
    },
    askUserQuestion: async () => {
      throw new Error('Approvals must use the approval port');
    },
    dismissInteraction: () => undefined,
  }, () => true, () => activeTurn);
  return { offered, router };
}

type ApprovalChoice = readonly [option: ProviderApprovalDecisionOption, nativeReply: unknown];

describe('Codex native approval choices', () => {
  afterEach(() => setLocale('en'));

  it.each<{
    name: string;
    method: string;
    params: Record<string, unknown>;
    description: () => string;
    choices: () => ApprovalChoice[];
    dismissed: unknown;
  }>([
    {
      name: 'command with Codex-offered decisions',
      method: 'item/commandExecution/requestApproval',
      params: {
        ...approvalScope, itemId: 'command-item', command: 'npm test',
        availableDecisions: ['accept', 'acceptForSession', execPolicyAmendment, networkAmendment, 'decline', 'cancel'],
      },
      description: () => t('chat.approval.execute', { command: 'npm test' }),
      choices: () => [
        [{ label: t('chat.approval.allowOnce'), value: 'allow-once', decision: 'allow' }, { decision: 'accept' }],
        [{ label: t('chat.approval.allowForSession'), value: 'allow-always', decision: 'allow-always' }, { decision: 'acceptForSession' }],
        [{
          label: t('chat.approval.allowSimilar'),
          description: t('chat.approval.execPolicyPrefix', { prefix: "npm run 'build docs'" }),
          value: JSON.stringify(execPolicyAmendment),
        }, { decision: execPolicyAmendment }],
        [{
          label: t('chat.approval.denyHost', { host: 'registry.npmjs.org' }),
          description: t('chat.approval.denyRule', { host: 'registry.npmjs.org' }),
          value: JSON.stringify(networkAmendment),
        }, { decision: networkAmendment }],
        [{ label: t('chat.approval.deny'), value: 'deny', decision: 'deny' }, { decision: 'decline' }],
        [{ label: t('chat.approval.denyAndStop'), value: 'cancel', decision: 'cancel' }, { decision: 'cancel' }],
      ],
      dismissed: { decision: 'cancel' },
    },
    {
      // Without `availableDecisions`, Codex 0.171 presents `default_available_decisions` (tui/src/approval_events.rs).
      name: 'command without offered decisions',
      method: 'item/commandExecution/requestApproval',
      params: { ...approvalScope, itemId: 'command-item', command: 'npm test' },
      description: () => t('chat.approval.execute', { command: 'npm test' }),
      choices: () => [
        [{ label: t('chat.approval.allowOnce'), value: 'allow-once', decision: 'allow' }, { decision: 'accept' }],
        [{ label: t('chat.approval.denyAndStop'), value: 'cancel', decision: 'cancel' }, { decision: 'cancel' }],
      ],
      dismissed: { decision: 'cancel' },
    },
    {
      name: 'command with proposed amendments but no offered decisions',
      method: 'item/commandExecution/requestApproval',
      params: {
        ...approvalScope, itemId: 'command-item', command: 'npm test',
        proposedExecpolicyAmendment: ['npm', 'run', 'build docs'],
        proposedNetworkPolicyAmendments: [{ host: 'registry.npmjs.org', action: 'deny' }],
      },
      description: () => t('chat.approval.execute', { command: 'npm test' }),
      choices: () => [
        [{ label: t('chat.approval.allowOnce'), value: 'allow-once', decision: 'allow' }, { decision: 'accept' }],
        [{
          label: t('chat.approval.allowSimilar'),
          description: t('chat.approval.execPolicyPrefix', { prefix: "npm run 'build docs'" }),
          value: JSON.stringify(execPolicyAmendment),
        }, { decision: execPolicyAmendment }],
        [{ label: t('chat.approval.denyAndStop'), value: 'cancel', decision: 'cancel' }, { decision: 'cancel' }],
      ],
      dismissed: { decision: 'cancel' },
    },
    {
      name: 'network command without offered decisions',
      method: 'item/commandExecution/requestApproval',
      params: {
        ...approvalScope, itemId: 'command-item', command: 'curl example.com',
        networkApprovalContext: { host: 'example.com', protocol: 'https' },
        proposedNetworkPolicyAmendments: [
          { host: 'registry.npmjs.org', action: 'deny' }, { host: 'example.com', action: 'allow' }, { host: 'other.test', action: 'allow' },
        ],
      },
      description: () => t('chat.approval.networkAccess', { protocol: 'https', host: 'example.com' }),
      choices: () => [
        [{ label: t('chat.approval.allowOnce'), value: 'allow-once', decision: 'allow' }, { decision: 'accept' }],
        [{ label: t('chat.approval.allowForSession'), value: 'allow-always', decision: 'allow-always' }, { decision: 'acceptForSession' }],
        [{
          label: t('chat.approval.allowHost', { host: 'example.com' }),
          description: t('chat.approval.allowRule', { host: 'example.com' }),
          value: JSON.stringify(allowExampleAmendment),
        }, { decision: allowExampleAmendment }],
        [{ label: t('chat.approval.denyAndStop'), value: 'cancel', decision: 'cancel' }, { decision: 'cancel' }],
      ],
      dismissed: { decision: 'cancel' },
    },
    {
      name: 'command with additional permissions and no offered decisions',
      method: 'item/commandExecution/requestApproval',
      params: {
        ...approvalScope, itemId: 'command-item', command: 'npm run build',
        additionalPermissions: { fileSystem: { write: ['/outside/build'] }, network: null },
      },
      description: () => [
        t('chat.approval.execute', { command: 'npm run build' }),
        t('chat.approval.permissionWrite', { paths: '/outside/build' }),
      ].join(' · '),
      choices: () => [
        [{ label: t('chat.approval.allowOnce'), value: 'allow-once', decision: 'allow' }, { decision: 'accept' }],
        [{ label: t('chat.approval.denyAndStop'), value: 'cancel', decision: 'cancel' }, { decision: 'cancel' }],
      ],
      dismissed: { decision: 'cancel' },
    },
    {
      name: 'file change',
      method: 'item/fileChange/requestApproval',
      params: { ...approvalScope, itemId: 'file-item', reason: 'Write outside the vault' },
      description: () => t('chat.approval.fileChangeReason', { reason: 'Write outside the vault' }),
      choices: () => [
        [{ label: t('chat.approval.allowOnce'), value: 'allow-once', decision: 'allow' }, { decision: 'accept' }],
        [{ label: t('chat.approval.allowFilesForSession'), value: 'allow-always', decision: 'allow-always' }, { decision: 'acceptForSession' }],
        // Codex's own file-change menu offers no decline that continues the turn (tui/src/bottom_pane/approval_overlay.rs).
        [{ label: t('chat.approval.denyAndStop'), value: 'cancel', decision: 'cancel' }, { decision: 'cancel' }],
      ],
      dismissed: { decision: 'cancel' },
    },
    {
      name: 'permissions',
      method: 'item/permissions/requestApproval',
      params: { ...approvalScope, itemId: 'permission-item', reason: 'Fetch dependencies', permissions: requestedPermissions },
      description: () => [
        t('chat.approval.permissionReason', { reason: 'Fetch dependencies' }),
        t('chat.approval.permissionWrite', { paths: '/tmp/out' }),
        t('chat.approval.permissionNetwork'),
      ].join(' · '),
      choices: () => [
        [{ label: t('chat.approval.allowForTurn'), value: 'allow-turn', decision: 'allow' }, { permissions: requestedPermissions, scope: 'turn' }],
        [{ label: t('chat.approval.allowForSession'), value: 'allow-session', decision: 'allow-always' }, { permissions: requestedPermissions, scope: 'session' }],
        [{ label: t('chat.approval.deny'), value: 'deny', decision: 'deny' }, { permissions: {}, scope: 'turn' }],
      ],
      dismissed: { permissions: {}, scope: 'turn' },
    },
    {
      name: 'permissions without a reason, as sandbox entries',
      method: 'item/permissions/requestApproval',
      params: { ...approvalScope, itemId: 'permission-item', reason: null, permissions: entryPermissions },
      description: () => [
        t('chat.approval.permissionRequest'),
        t('chat.approval.permissionRead', { paths: [
          '/vault/notes', '**/*.md', t('chat.approval.permissionFullDisk'), t('chat.approval.permissionMinimalPaths'),
          t('chat.approval.permissionProjectRoots'), ':future/docs',
        ].join(', ') }),
        t('chat.approval.permissionWrite', { paths: [
          t('chat.approval.permissionProjectRootsSubpath', { subpath: 'build' }), '$TMPDIR', '/tmp',
        ].join(', ') }),
        // Exclusions narrow what the grant allows; Codex shows them too.
        t('chat.approval.permissionDenyRead', { paths: '/vault/.secrets' }),
      ].join(' · '),
      choices: () => [
        [{ label: t('chat.approval.allowForTurn'), value: 'allow-turn', decision: 'allow' }, { permissions: entryPermissions, scope: 'turn' }],
        [{ label: t('chat.approval.allowForSession'), value: 'allow-session', decision: 'allow-always' }, { permissions: entryPermissions, scope: 'session' }],
        [{ label: t('chat.approval.deny'), value: 'deny', decision: 'deny' }, { permissions: {}, scope: 'turn' }],
      ],
      dismissed: { permissions: {}, scope: 'turn' },
    },
  ])('offers the native $name choices, localized, and replies with the chosen one', async ({ method, params, description, choices, dismissed }) => {
    setLocale('en');
    const englishDescription = description();
    setLocale('zh-CN');
    expect(description()).not.toBe(englishDescription);
    let choose: (request: ProviderApprovalInteractionRequest) => string | null = () => null;
    const { offered, router } = createApprovalRouter(request => choose(request));
    const expected = choices();

    for (const [index, [, nativeReply]] of expected.entries()) {
      choose = request => request.decisionOptions[index].value;
      await expect(router.handleServerRequest(`choice-${index}`, method, params)).resolves.toEqual(nativeReply);
    }
    choose = () => null;
    await expect(router.handleServerRequest('dismissed', method, params)).resolves.toEqual(dismissed);

    expect(offered).toHaveLength(expected.length + 1);
    for (const request of offered) {
      expect(request.description).toBe(description());
      expect(request.decisionOptions).toEqual(expected.map(([option]) => option));
    }
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a forged amendment', {}, JSON.stringify(execPolicyAmendment)],
    ['malformed JSON', {}, '{"acceptWithExecpolicyAmendment"'],
    ['a session grant Codex did not offer', { availableDecisions: ['accept', 'decline'] }, 'allow-always'],
    ['a session grant the request does not evidence', {}, 'allow-always'],
  ])('declines a command reply naming %s', async (_name, offeredDecisions, value) => {
    const { offered, router } = createApprovalRouter(() => value);
    await expect(router.handleServerRequest('forged', 'item/commandExecution/requestApproval', {
      ...approvalScope, itemId: 'command-item', command: 'npm test', ...offeredDecisions,
    })).resolves.toEqual({ decision: 'decline' });
    expect(offered).toHaveLength(1);
  });
});
