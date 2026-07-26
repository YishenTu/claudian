import '@/providers';

import { JsonRpcErrorResponse } from '@/providers/acp';
import { getKimiDiscoveryState } from '@/providers/kimi/discoveryState';
import { KimiChatRuntime } from '@/providers/kimi/runtime/KimiChatRuntime';
import { getKimiProviderSettings } from '@/providers/kimi/settings';

function createMockPlugin(overrides: Record<string, unknown> = {}): any {
  const plugin: any = {
    app: {
      vault: {
        adapter: { basePath: '/tmp/claudian-kimi-vault' },
      },
    },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/usr/local/bin/kimi'),
    manifest: { version: '0.0.0-test' },
    notifyProviderChatOptionsChanged: jest.fn(),
    saveSettings: jest.fn().mockResolvedValue(undefined),
    settings: {
      model: '',
      providerConfigs: {
        kimi: { enabled: true },
      },
    },
    ...overrides,
  };
  plugin.mutateSettings ??= jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  return plugin;
}

function modelConfigOption(currentValue: string): Record<string, unknown> {
  return {
    type: 'select',
    category: 'model',
    id: 'model',
    name: 'Model',
    currentValue,
    options: [
      { value: 'kimi-for-coding', name: 'Kimi Coding', description: 'Kimi coding model' },
      { value: 'kimi-k2', name: 'K2' },
    ],
  };
}

function thinkingConfigOption(currentValue: string): Record<string, unknown> {
  return {
    type: 'select',
    category: 'thought_level',
    id: 'thinking',
    name: 'Thinking',
    currentValue,
    options: [
      { value: 'off', name: 'Off' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  };
}

function modeConfigOption(currentValue: string): Record<string, unknown> {
  return {
    type: 'select',
    category: 'mode',
    id: 'mode',
    name: 'Mode',
    currentValue,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
      { value: 'auto', name: 'Auto' },
      { value: 'yolo', name: 'YOLO' },
    ],
  };
}

// Fixtures from a live kimi acp probe (CLI 0.29.0): the coding models advertise
// a single 'on' thought level, the K3 models advertise low/high/max.
function codingThoughtLevelConfigOption(): Record<string, unknown> {
  return {
    type: 'select',
    category: 'thought_level',
    id: 'thinking',
    name: 'Thinking',
    currentValue: 'on',
    options: [{ value: 'on', name: 'On' }],
  };
}

function k3ThoughtLevelConfigOption(): Record<string, unknown> {
  return {
    type: 'select',
    category: 'thought_level',
    id: 'thinking',
    name: 'Thinking',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
      { value: 'max', name: 'Max' },
    ],
  };
}

async function drainQuery(runtime: KimiChatRuntime, text = 'Hi'): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of runtime.query(runtime.prepareTurn({ text }))) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('KimiChatRuntime', () => {
  it('rejects a second overlapping query without replacing the active route', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    (runtime as any).activeTurn = {
      cancelled: false,
      queue: { close: jest.fn(), next: jest.fn(), push: jest.fn() },
      sessionId: 'session-1',
    };

    const chunks: unknown[] = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'Second' }))) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'error', content: 'Kimi does not support overlapping turns.' },
      { type: 'done' },
    ]);
    expect((runtime as any).activeTurn.sessionId).toBe('session-1');
  });

  it('streams agent message chunks as text and closes with done', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    (runtime as any).connection = {
      prompt: jest.fn(async ({ sessionId }: { sessionId: string }) => {
        await (runtime as any).handleSessionNotification({
          sessionId,
          update: {
            content: { text: 'Hello from Kimi', type: 'text' },
            messageId: 'assistant-1',
            sessionUpdate: 'agent_message_chunk',
          },
        });
        return { stopReason: 'end_turn' };
      }),
    };

    const chunks = await drainQuery(runtime);

    expect(chunks).toContainEqual({ content: 'Hello from Kimi', type: 'text' });
    expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
    expect(runtime.consumeTurnMetadata()).toEqual({ assistantMessageId: 'assistant-1' });
  });

  it('strips the kimi turn prefix from tool call ids before normalization', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    (runtime as any).connection = {
      prompt: jest.fn(async ({ sessionId }: { sessionId: string }) => {
        await (runtime as any).handleSessionNotification({
          sessionId,
          update: {
            kind: 'other',
            rawInput: { command: 'ls' },
            sessionUpdate: 'tool_call',
            status: 'completed',
            title: 'Bash',
            toolCallId: '3:tool-1',
          },
        });
        return { stopReason: 'end_turn' };
      }),
    };

    const chunks = await drainQuery(runtime, 'Run ls');

    expect(chunks).toContainEqual(expect.objectContaining({
      id: 'tool-1',
      type: 'tool_use',
    }));
    expect(JSON.stringify(chunks)).not.toContain('3:tool-1');
  });

  it('ignores notifications from a superseded ACP connection generation', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    const push = jest.fn();
    (runtime as any).sessionId = 'session-1';
    (runtime as any).connectionGeneration = 2;
    (runtime as any).activeTurn = {
      cancelled: false,
      queue: { close: jest.fn(), push },
      sessionId: 'session-1',
    };

    await (runtime as any).handleSessionNotification({
      sessionId: 'session-1',
      update: {
        content: { text: 'stale', type: 'text' },
        messageId: 'assistant-old',
        sessionUpdate: 'agent_message_chunk',
      },
    }, 1);

    expect(push).not.toHaveBeenCalled();
  });

  it('maps ACP permission options through the shared approval callback', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    const approvalCallback = jest.fn().mockResolvedValue('allow');
    runtime.setApprovalCallback(approvalCallback);
    const request = {
      options: [
        { kind: 'allow_once', name: 'Approve once', optionId: 'approve_once' },
        { kind: 'allow_always', name: 'Approve for this session', optionId: 'approve_always' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'other',
        rawInput: { command: 'ls -la' },
        title: 'Bash: ls -la',
        toolCallId: 'tool-1',
      },
    };

    await expect((runtime as any).handlePermissionRequest(request)).resolves.toEqual({
      outcome: { optionId: 'approve_once', outcome: 'selected' },
    });
    expect(approvalCallback).toHaveBeenCalledWith(
      'Bash',
      { command: 'ls -la' },
      'Kimi wants to use Bash.',
      {
        decisionOptions: [
          { decision: 'allow', label: 'Approve once', value: 'approve_once' },
          { decision: 'allow-always', label: 'Approve for this session', value: 'approve_always' },
          { label: 'Reject', value: 'reject' },
        ],
      },
    );

    approvalCallback.mockResolvedValue('allow-always');
    await expect((runtime as any).handlePermissionRequest(request)).resolves.toEqual({
      outcome: { optionId: 'approve_always', outcome: 'selected' },
    });

    approvalCallback.mockResolvedValue('deny');
    await expect((runtime as any).handlePermissionRequest(request)).resolves.toEqual({
      outcome: { optionId: 'reject', outcome: 'selected' },
    });
  });

  it('surfaces plan_review options as distinct choices that round-trip their own ids', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    const approvalCallback = jest.fn().mockResolvedValue({ type: 'select-option', value: 'plan_opt_1' });
    runtime.setApprovalCallback(approvalCallback);
    const request = {
      options: [
        { kind: 'allow_once', name: 'Option A', optionId: 'plan_opt_0' },
        { kind: 'allow_once', name: 'Option B', optionId: 'plan_opt_1' },
        { kind: 'reject_once', name: 'Revise', optionId: 'plan_revise' },
        { kind: 'reject_once', name: 'Reject and Exit', optionId: 'plan_reject_and_exit' },
      ],
      sessionId: 'session-1',
      toolCall: {
        content: [{ type: 'content', content: { type: 'text', text: '# Plan\n\nDo things.' } }],
        title: 'ExitPlanMode',
        toolCallId: '3:tool-9',
      },
    };

    await expect((runtime as any).handlePermissionRequest(request)).resolves.toEqual({
      outcome: { optionId: 'plan_opt_1', outcome: 'selected' },
    });
    expect(approvalCallback).toHaveBeenCalledWith(
      'Exit Plan Mode',
      {},
      '# Plan\n\nDo things.',
      {
        decisionOptions: [
          { label: 'Option A', value: 'plan_opt_0' },
          { label: 'Option B', value: 'plan_opt_1' },
          { label: 'Revise', value: 'plan_revise' },
          { label: 'Reject and Exit', value: 'plan_reject_and_exit' },
        ],
      },
    );

    approvalCallback.mockResolvedValue('cancel');
    await expect((runtime as any).handlePermissionRequest(request)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('cancels permission requests when no approval callback is installed', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());

    await expect((runtime as any).handlePermissionRequest({
      options: [{ kind: 'allow_once', name: 'Approve once', optionId: 'approve_once' }],
      sessionId: 'session-1',
      toolCall: { title: 'Read', toolCallId: 'tool-1' },
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('surfaces ACP AUTH_REQUIRED with the terminal-auth command guidance', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    (runtime as any).connection = {
      newSession: jest.fn().mockRejectedValue(new JsonRpcErrorResponse(
        'session/new',
        -32000,
        'Authentication required',
        {
          authMethods: [{
            _meta: { 'terminal-auth': { args: ['login', '--browser'], command: 'kimi' } },
          }],
        },
      )),
    };

    const chunks = await drainQuery(runtime);

    expect(chunks).toEqual([
      {
        type: 'error',
        content: 'Kimi requires authentication. '
          + 'Run `kimi login --browser` in a terminal to log in, then retry.',
      },
      { type: 'done' },
    ]);
  });

  it('falls back to kimi login guidance when AUTH_REQUIRED carries no metadata', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    (runtime as any).connection = {
      newSession: jest.fn().mockRejectedValue(
        new JsonRpcErrorResponse('session/new', -32000, 'Authentication required'),
      ),
    };

    const chunks = await drainQuery(runtime);

    expect(chunks).toEqual([
      {
        type: 'error',
        content: 'Kimi requires authentication. '
          + 'Run `kimi login` in a terminal to log in, then retry.',
      },
      { type: 'done' },
    ]);
  });

  it('captures available ACP commands for the active session', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';

    const commandsPromise = runtime.discoverSupportedCommands(5_000);
    await (runtime as any).handleSessionNotification({
      sessionId: 'session-1',
      update: {
        availableCommands: [{ description: 'Review changes', name: 'review' }],
        sessionUpdate: 'available_commands_update',
      },
    });

    await expect(commandsPromise).resolves.toEqual([{
      content: '',
      description: 'Review changes',
      id: 'acp:review',
      name: 'review',
      source: 'sdk',
    }]);
  });

  it('rejects command waiters on malformed metadata, cleanup, and conversation changes', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-malformed' });
    (runtime as any).loadedSessionId = 'session-malformed';
    const malformedPromise = runtime.discoverSupportedCommands(5_000);

    await (runtime as any).handleSessionNotification({
      sessionId: 'session-malformed',
      update: { availableCommands: null, sessionUpdate: 'available_commands_update' },
    });
    await expect(malformedPromise).rejects.toThrow('Kimi sent malformed command metadata.');

    const cleanupPromise = runtime.discoverSupportedCommands(5_000);
    runtime.cleanup();
    await expect(cleanupPromise).rejects.toThrow('Kimi runtime stopped.');

    const restarted = new KimiChatRuntime(createMockPlugin());
    restarted.syncConversationState({ providerState: {}, sessionId: 'session-a' });
    const changePromise = restarted.discoverSupportedCommands(5_000);
    restarted.syncConversationState({ providerState: {}, sessionId: 'session-b' });
    await expect(changePromise).rejects.toThrow('Kimi command discovery context changed.');
  });

  it('mirrors discovered models, thinking options, and modes from session config options', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    const permissionModeSync = jest.fn();
    runtime.setPermissionModeSyncCallback(permissionModeSync);

    await (runtime as any).syncSessionConfigState({
      configOptions: [
        modelConfigOption('kimi-k2'),
        thinkingConfigOption('medium'),
        modeConfigOption('plan'),
      ],
    });

    expect(runtime.getDiscoveredModels()).toEqual([
      { description: 'Kimi coding model', label: 'Kimi Coding', rawId: 'kimi-for-coding' },
      { label: 'K2', rawId: 'kimi-k2' },
    ]);
    expect((runtime as any).currentSessionModelId).toBe('kimi-k2');
    expect((runtime as any).currentSessionModeId).toBe('plan');
    expect((runtime as any).currentThinkingConfigId).toBe('thinking');
    expect((runtime as any).currentThinkingValue).toBe('medium');
    expect(permissionModeSync).toHaveBeenCalledWith('plan');

    const discovery = getKimiDiscoveryState(plugin.settings);
    expect(discovery.thinkingOptionsByModel).toEqual({
      'kimi-k2': [
        { label: 'Off', value: 'off' },
        { label: 'Medium', value: 'medium' },
        { label: 'High', value: 'high' },
      ],
    });
    expect(discovery.currentThinkingByModel).toEqual({ 'kimi-k2': 'medium' });
    expect(plugin.notifyProviderChatOptionsChanged).toHaveBeenCalledWith('kimi');
  });

  it('mirrors and persists the discovered model catalog from session config options', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);

    await (runtime as any).syncSessionConfigState({
      configOptions: [modelConfigOption('kimi-k2')],
    });

    const expected = [
      { description: 'Kimi coding model', label: 'Kimi Coding', rawId: 'kimi-for-coding' },
      { label: 'K2', rawId: 'kimi-k2' },
    ];
    expect(getKimiDiscoveryState(plugin.settings).discoveredModels).toEqual(expected);
    expect(getKimiProviderSettings(plugin.settings).discoveredModels).toEqual(expected);
    const stored = (plugin.settings.providerConfigs as Record<string, Record<string, unknown>>).kimi;
    expect(stored.discoveredModels).toEqual(expected);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it('keeps the mirrored catalog when a session reports no models', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);

    await (runtime as any).syncSessionConfigState({
      configOptions: [modelConfigOption('kimi-k2')],
    });
    const before = getKimiDiscoveryState(plugin.settings).discoveredModels;
    expect(before).not.toEqual([]);

    await (runtime as any).syncSessionConfigState({
      configOptions: [thinkingConfigOption('medium')],
    });

    expect(getKimiDiscoveryState(plugin.settings).discoveredModels).toEqual(before);
    expect(getKimiProviderSettings(plugin.settings).discoveredModels).toEqual(before);
  });

  it('probes thinking options for every model in one batch without touching settings', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    (runtime as any).sessionId = 'session-1';
    const setConfigOption = jest.fn(async ({ value }: { value: string }) => ({
      configOptions: [
        modelConfigOption(value),
        value.startsWith('kimi-code/k3')
          ? k3ThoughtLevelConfigOption()
          : codingThoughtLevelConfigOption(),
      ],
    }));
    (runtime as any).connection = { setConfigOption };

    const probe = await runtime.probeThinkingOptionsForModels([
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed',
      'kimi-code/k3',
      'kimi-code/k3-256k',
    ]);

    expect(setConfigOption).toHaveBeenCalledTimes(4);
    expect(setConfigOption).toHaveBeenCalledWith({
      configId: 'model',
      sessionId: 'session-1',
      type: 'select',
      value: 'kimi-code/k3-256k',
    });
    expect(probe.failedRawIds).toEqual([]);
    expect(probe.noThinkingRawIds).toEqual([]);
    expect(probe.thinkingOptionsByModel).toEqual({
      'kimi-code/kimi-for-coding': [{ label: 'On', value: 'on' }],
      'kimi-code/kimi-for-coding-highspeed': [{ label: 'On', value: 'on' }],
      'kimi-code/k3': [
        { label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
        { label: 'Max', value: 'max' },
      ],
      'kimi-code/k3-256k': [
        { label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
        { label: 'Max', value: 'max' },
      ],
    });
    expect(probe.currentThinkingByModel).toEqual({
      'kimi-code/kimi-for-coding': 'on',
      'kimi-code/kimi-for-coding-highspeed': 'on',
      'kimi-code/k3': 'high',
      'kimi-code/k3-256k': 'high',
    });
    // Pure accumulation: no mirror update, no persistence.
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(getKimiDiscoveryState(plugin.settings).thinkingOptionsByModel).toEqual({});
  });

  it('tolerates per-model probe failures and reports models without thought levels', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    (runtime as any).sessionId = 'session-1';
    const setConfigOption = jest.fn(async ({ value }: { value: string }) => {
      if (value === 'kimi-code/kimi-for-coding-highspeed') {
        throw new Error('set_config_option failed');
      }
      return {
        configOptions: [
          modelConfigOption(value),
          ...(value === 'kimi-code/k3' ? [] : [codingThoughtLevelConfigOption()]),
        ],
      };
    });
    (runtime as any).connection = { setConfigOption };

    const probe = await runtime.probeThinkingOptionsForModels([
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed',
      'kimi-code/k3',
    ]);

    expect(probe.failedRawIds).toEqual(['kimi-code/kimi-for-coding-highspeed']);
    expect(probe.noThinkingRawIds).toEqual(['kimi-code/k3']);
    expect(probe.thinkingOptionsByModel).toEqual({
      'kimi-code/kimi-for-coding': [{ label: 'On', value: 'on' }],
    });
    expect(probe.currentThinkingByModel).toEqual({ 'kimi-code/kimi-for-coding': 'on' });
  });

  it('fails the whole batch probe when no session is active', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);

    const probe = await runtime.probeThinkingOptionsForModels(['kimi-code/k3', ' ']);

    expect(probe.failedRawIds).toEqual(['kimi-code/k3']);
    expect(probe.thinkingOptionsByModel).toEqual({});
  });

  it('mirrors and persists thinking options and current levels per model', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);

    await (runtime as any).syncSessionConfigState({
      configOptions: [modelConfigOption('kimi-k2'), thinkingConfigOption('medium')],
    });

    const expectedOptions = [
      { label: 'Off', value: 'off' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ];
    expect(getKimiProviderSettings(plugin.settings).thinkingOptionsByModel).toEqual({
      'kimi-k2': expectedOptions,
    });
    expect(getKimiProviderSettings(plugin.settings).currentThinkingByModel).toEqual({
      'kimi-k2': 'medium',
    });
    const stored = (plugin.settings.providerConfigs as Record<string, Record<string, unknown>>).kimi;
    expect(stored.thinkingOptionsByModel).toEqual({ 'kimi-k2': expectedOptions });
    expect(stored.currentThinkingByModel).toEqual({ 'kimi-k2': 'medium' });
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it('drops the thinking mirror when the session model stops advertising thought levels', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);

    await (runtime as any).syncSessionConfigState({
      configOptions: [modelConfigOption('kimi-k2'), thinkingConfigOption('medium')],
    });
    expect(getKimiDiscoveryState(plugin.settings).thinkingOptionsByModel).not.toEqual({});

    await (runtime as any).syncSessionConfigState({
      configOptions: [modelConfigOption('kimi-k2')],
    });

    expect((runtime as any).currentThinkingConfigId).toBeNull();
    expect((runtime as any).currentThinkingValue).toBeNull();
    expect(getKimiDiscoveryState(plugin.settings).thinkingOptionsByModel).toEqual({});
    expect(getKimiDiscoveryState(plugin.settings).currentThinkingByModel).toEqual({});
    expect(getKimiProviderSettings(plugin.settings).thinkingOptionsByModel).toEqual({});
    expect(getKimiProviderSettings(plugin.settings).currentThinkingByModel).toEqual({});
  });

  it('applies config_option_update notifications to the discovered session state', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';

    await (runtime as any).handleSessionNotification({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          modelConfigOption('kimi-for-coding'),
          thinkingConfigOption('high'),
          modeConfigOption('default'),
        ],
      },
    });

    expect((runtime as any).currentSessionModelId).toBe('kimi-for-coding');
    expect((runtime as any).currentThinkingValue).toBe('high');
    expect(getKimiDiscoveryState(plugin.settings).thinkingOptionsByModel['kimi-for-coding'])
      .toHaveLength(3);
  });

  it('switches the session model through session/set_config_option', async () => {
    const plugin = createMockPlugin();
    plugin.settings.model = 'kimi:kimi-k2';
    const runtime = new KimiChatRuntime(plugin);
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    const setConfigOption = jest.fn().mockResolvedValue({
      configOptions: [modelConfigOption('kimi-k2'), thinkingConfigOption('medium')],
    });
    (runtime as any).connection = {
      setConfigOption,
      prompt: jest.fn(async () => ({ stopReason: 'end_turn' })),
    };
    await (runtime as any).syncSessionConfigState({
      configOptions: [modelConfigOption('kimi-for-coding'), thinkingConfigOption('medium')],
    });

    await drainQuery(runtime);

    expect(setConfigOption).toHaveBeenCalledWith({
      configId: 'model',
      sessionId: 'session-1',
      type: 'select',
      value: 'kimi-k2',
    });
    expect((runtime as any).currentSessionModelId).toBe('kimi-k2');
  });

  it('switches the thinking effort through session/set_config_option', async () => {
    const plugin = createMockPlugin();
    const runtime = new KimiChatRuntime(plugin);
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    const setConfigOption = jest.fn().mockResolvedValue({
      configOptions: [modelConfigOption('kimi-for-coding'), thinkingConfigOption('high')],
    });
    (runtime as any).connection = {
      setConfigOption,
      prompt: jest.fn(async () => ({ stopReason: 'end_turn' })),
    };
    await (runtime as any).syncSessionConfigState({
      configOptions: [modelConfigOption('kimi-for-coding'), thinkingConfigOption('medium')],
    });
    (runtime as any).getProviderSettings = () => ({ effortLevel: 'high', model: '' });

    await drainQuery(runtime);

    expect(setConfigOption).toHaveBeenCalledWith({
      configId: 'thinking',
      sessionId: 'session-1',
      type: 'select',
      value: 'high',
    });
    expect((runtime as any).currentThinkingValue).toBe('high');
  });

  it('does not write an effort that the session never advertised', async () => {
    const runtime = new KimiChatRuntime(createMockPlugin());
    const setConfigOption = jest.fn();
    (runtime as any).connection = { setConfigOption };
    (runtime as any).currentThinkingConfigId = 'thinking';
    (runtime as any).currentThinkingValues = new Set(['off', 'on']);
    (runtime as any).currentThinkingValue = 'off';
    (runtime as any).getProviderSettings = () => ({ effortLevel: 'xhigh', model: '' });

    await (runtime as any).applySelectedEffort('session-1');

    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it('enters plan mode through session/set_mode when the permission mode is plan', async () => {
    const plugin = createMockPlugin();
    plugin.settings.permissionMode = 'plan';
    const runtime = new KimiChatRuntime(plugin);
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    const setMode = jest.fn().mockResolvedValue({});
    (runtime as any).connection = {
      setMode,
      prompt: jest.fn(async () => ({ stopReason: 'end_turn' })),
    };
    await (runtime as any).syncSessionConfigState({
      configOptions: [modelConfigOption('kimi-for-coding'), modeConfigOption('default')],
    });

    await drainQuery(runtime);

    expect(setMode).toHaveBeenCalledWith({ modeId: 'plan', sessionId: 'session-1' });
    expect((runtime as any).currentSessionModeId).toBe('plan');
  });

  it('leaves plan mode through session/set_mode when the permission mode returns to normal', async () => {
    const plugin = createMockPlugin();
    plugin.settings.permissionMode = 'normal';
    const runtime = new KimiChatRuntime(plugin);
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    const setMode = jest.fn().mockResolvedValue({});
    (runtime as any).connection = {
      setMode,
      prompt: jest.fn(async () => ({ stopReason: 'end_turn' })),
    };
    await (runtime as any).syncSessionConfigState({
      configOptions: [modelConfigOption('kimi-for-coding'), modeConfigOption('plan')],
    });

    await drainQuery(runtime);

    expect(setMode).toHaveBeenCalledWith({ modeId: 'default', sessionId: 'session-1' });
    expect((runtime as any).currentSessionModeId).toBe('default');
  });

  it('skips mode writes when the session never advertised modes', async () => {
    const plugin = createMockPlugin();
    plugin.settings.permissionMode = 'plan';
    const runtime = new KimiChatRuntime(plugin);
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';
    (runtime as any).ensureReady = jest.fn().mockResolvedValue(true);
    const setMode = jest.fn();
    (runtime as any).connection = {
      setMode,
      prompt: jest.fn(async () => ({ stopReason: 'end_turn' })),
    };

    await drainQuery(runtime);

    expect(setMode).not.toHaveBeenCalled();
  });
});
