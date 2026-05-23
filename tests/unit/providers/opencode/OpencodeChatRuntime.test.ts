import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import {
  OPENCODE_BUILD_MODE_ID,
  OPENCODE_SAFE_MODE_ID,
  OPENCODE_YOLO_MODE_ID,
} from '@/providers/opencode/modes';
import { OpencodeChatRuntime } from '@/providers/opencode/runtime/OpencodeChatRuntime';
import * as launchArtifacts from '@/providers/opencode/runtime/OpencodeLaunchArtifacts';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

function createMockPlugin(overrides: Record<string, unknown> = {}): any {
  return {
    settings: {},
    manifest: { version: '0.0.0-test' },
    getAllViews: jest.fn().mockReturnValue([]),
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/usr/local/bin/opencode'),
    saveSettings: jest.fn().mockResolvedValue(undefined),
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/claudian-test-vault',
        },
      },
    },
    ...overrides,
  };
}

describe('OpencodeChatRuntime', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('captures available ACP commands even when no turn is active', async () => {
    const runtime = new OpencodeChatRuntime(createMockPlugin());
    runtime.syncConversationState({ providerState: {}, sessionId: 'session-1' });

    (runtime as any).loadedSessionId = 'session-1';

    const commandsPromise = runtime.getSupportedCommands();

    await (runtime as any).handleSessionNotification({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: 'Review changes' },
          { name: 'fix', description: 'Fix the issue' },
        ],
      },
    });

    await expect(commandsPromise).resolves.toEqual([
      {
        id: 'acp:review',
        name: 'review',
        description: 'Review changes',
        content: '',
        source: 'sdk',
      },
      {
        id: 'acp:fix',
        name: 'fix',
        description: 'Fix the issue',
        content: '',
        source: 'sdk',
      },
    ]);
  });

  it('does not create a session when commands are requested before a session exists', async () => {
    const runtime = new OpencodeChatRuntime(createMockPlugin());

    (runtime as any).ready = true;
    (runtime as any).createSession = jest.fn();

    await expect(runtime.getSupportedCommands()).resolves.toEqual([]);
    expect((runtime as any).createSession).not.toHaveBeenCalled();
  });

  it('marks missing saved sessions invalidated without creating a replacement command session', async () => {
    const plugin = createMockPlugin({
      settings: {
        providerConfigs: {
          opencode: {
            enabled: true,
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    runtime.syncConversationState({
      providerState: { databasePath: '/persisted/opencode.db' },
      sessionId: 'session-1',
    });

    jest.spyOn(launchArtifacts, 'prepareOpencodeLaunchArtifacts').mockImplementation(async (params) => {
      expect(params.runtimeEnv.OPENCODE_DB).toBe('/persisted/opencode.db');
      return {
        configPath: '/tmp/claudian-opencode-config.json',
        configContent: '{}\n',
        databasePath: '/persisted/opencode.db',
        launchKey: 'launch-key',
        systemPromptPath: '/tmp/claudian-opencode-system.md',
      };
    });
    (runtime as any).startProcess = jest.fn().mockImplementation(async () => {
      (runtime as any).ready = true;
    });
    (runtime as any).loadSession = jest.fn().mockResolvedValue(false);
    (runtime as any).createSession = jest.fn().mockResolvedValue('session-2');

    await expect(runtime.ensureReady()).resolves.toBe(true);
    await expect(runtime.getSupportedCommands()).resolves.toEqual([]);
    expect((runtime as any).createSession).not.toHaveBeenCalled();
    expect(runtime.getSessionId()).toBeNull();
    expect(runtime.consumeSessionInvalidation()).toBe(true);
    expect(runtime.consumeSessionInvalidation()).toBe(false);
  });

  it('clears a stale database path when switching to a saved session without persisted provider state', async () => {
    const plugin = createMockPlugin({
      settings: {
        providerConfigs: {
          opencode: {
            enabled: true,
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    runtime.syncConversationState({
      providerState: { databasePath: '/persisted/opencode.db' },
      sessionId: 'session-1',
    });
    runtime.syncConversationState({
      providerState: {},
      sessionId: 'session-2',
    });

    jest.spyOn(launchArtifacts, 'prepareOpencodeLaunchArtifacts').mockImplementation(async (params) => {
      expect(params.runtimeEnv.OPENCODE_DB).toBeUndefined();
      return {
        configPath: '/tmp/claudian-opencode-config.json',
        configContent: '{}\n',
        databasePath: '/default/opencode.db',
        launchKey: 'launch-key',
        systemPromptPath: '/tmp/claudian-opencode-system.md',
      };
    });
    (runtime as any).startProcess = jest.fn().mockImplementation(async () => {
      (runtime as any).ready = true;
    });
    (runtime as any).loadSession = jest.fn().mockResolvedValue(true);

    await expect(runtime.ensureReady()).resolves.toBe(true);
  });

  it('honors a metadata-only database override before any session exists', async () => {
    const plugin = createMockPlugin({
      settings: {
        providerConfigs: {
          opencode: {
            enabled: true,
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    runtime.syncConversationState({
      providerState: { databasePath: ':memory:' },
      sessionId: null,
    });

    jest.spyOn(launchArtifacts, 'prepareOpencodeLaunchArtifacts').mockImplementation(async (params) => {
      expect(params.runtimeEnv.OPENCODE_DB).toBe(':memory:');
      return {
        configPath: '/tmp/claudian-opencode-config.json',
        configContent: '{}\n',
        databasePath: ':memory:',
        launchKey: 'launch-key',
        systemPromptPath: '/tmp/claudian-opencode-system.md',
      };
    });
    (runtime as any).startProcess = jest.fn().mockImplementation(async () => {
      (runtime as any).ready = true;
    });

    await expect(runtime.ensureReady({ allowSessionCreation: false })).resolves.toBe(true);
  });

  it('restarts when the ACP transport closed even if the subprocess still looks alive', async () => {
    const plugin = createMockPlugin({
      settings: {
        providerConfigs: {
          opencode: {
            enabled: true,
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    const mockTransport = { dispose: jest.fn(), isClosed: false };
    const mockProcess = { isAlive: jest.fn().mockReturnValue(true), shutdown: jest.fn() };
    const mockConnection = { dispose: jest.fn() };

    jest.spyOn(launchArtifacts, 'prepareOpencodeLaunchArtifacts').mockResolvedValue({
      configPath: '/tmp/claudian-opencode-config.json',
      configContent: '{}\n',
      databasePath: '/default/opencode.db',
      launchKey: 'launch-key',
      systemPromptPath: '/tmp/claudian-opencode-system.md',
    });
    const shutdownProcess = jest.spyOn(runtime as any, 'shutdownProcess').mockResolvedValue(undefined);
    const startProcess = jest.spyOn(runtime as any, 'startProcess').mockImplementation(async () => {
      (runtime as any).connection = mockConnection;
      (runtime as any).process = mockProcess;
      (runtime as any).transport = mockTransport;
    });

    await expect(runtime.ensureReady({ allowSessionCreation: false })).resolves.toBe(true);
    mockTransport.isClosed = true;
    await expect(runtime.ensureReady({ allowSessionCreation: false })).resolves.toBe(true);

    expect(shutdownProcess).toHaveBeenCalledTimes(2);
    expect(startProcess).toHaveBeenCalledTimes(2);
  });

  it('maps ACP permission options through the shared approval UI', async () => {
    const runtime = new OpencodeChatRuntime(createMockPlugin());
    const approvalCallback = jest.fn().mockResolvedValue('allow');

    runtime.setApprovalCallback(approvalCallback);

    await expect((runtime as any).handlePermissionRequest({
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'approve-now' },
        { kind: 'allow_always', name: 'Always allow', optionId: 'approve-always' },
        { kind: 'reject_once', name: 'Deny', optionId: 'deny-now' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'other',
        rawInput: { filepath: '/tmp/outside', parentDir: '/tmp' },
        title: 'external_directory',
        toolCallId: 'tool-1',
      },
    })).resolves.toEqual({
      outcome: {
        optionId: 'approve-now',
        outcome: 'selected',
      },
    });

    expect(approvalCallback).toHaveBeenCalledWith(
      'External Directory',
      { filepath: '/tmp/outside', parentDir: '/tmp' },
      'OpenCode wants to access a path outside the working directory.',
      {
        blockedPath: '/tmp/outside',
        decisionOptions: [
          { decision: 'allow', label: 'Allow once', value: 'approve-now' },
          { decision: 'allow-always', label: 'Always allow', value: 'approve-always' },
          { label: 'Deny', value: 'deny-now' },
        ],
        decisionReason: 'Path is outside the session working directory',
      },
    );
  });

  it('forces the Claude prompt flag while preserving the project config flag', () => {
    const runtime = new OpencodeChatRuntime(createMockPlugin({
      settings: {
        sharedEnvironmentVariables: 'OPENCODE_DISABLE_PROJECT_CONFIG=false\nOPENCODE_DISABLE_CLAUDE_CODE_PROMPT=false',
      },
    }));

    const env = (runtime as any).buildRuntimeEnv('/usr/local/bin/opencode', '/tmp/opencode.db');

    expect(env.OPENCODE_DB).toBe('/tmp/opencode.db');
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('false');
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT).toBe('true');
  });

  it('returns the nested ACP approval envelope for allow-always selections', async () => {
    const runtime = new OpencodeChatRuntime(createMockPlugin());
    runtime.setApprovalCallback(jest.fn().mockResolvedValue('allow-always'));

    await expect((runtime as any).handlePermissionRequest({
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'approve-now' },
        { kind: 'allow_always', name: 'Always allow', optionId: 'approve-always' },
        { kind: 'reject_once', name: 'Reject', optionId: 'deny-now' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'other',
        rawInput: { filepath: '/tmp/outside', parentDir: '/tmp' },
        title: 'external_directory',
        toolCallId: 'tool-1',
      },
    })).resolves.toEqual({
      outcome: {
        optionId: 'approve-always',
        outcome: 'selected',
      },
    });
  });

  it('syncs OpenCode session modes into provider settings without clobbering an explicit user choice', async () => {
    const refreshModelSelector = jest.fn();
    const plugin = createMockPlugin({
      getAllViews: jest.fn().mockReturnValue([{ refreshModelSelector }]),
      settings: {
        providerConfigs: {
          opencode: {
            availableModes: [
              { id: 'build', name: 'Build' },
            ],
            selectedMode: 'plan',
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);

    await (runtime as any).syncSessionModeState({
      configOptions: [{
        currentValue: 'build',
        id: 'mode',
        name: 'Mode',
        options: [
          { name: 'Build', value: 'build' },
          { description: 'Planning-first agent', name: 'Plan', value: 'plan' },
        ],
        type: 'select',
      }],
    });

    expect(getOpencodeProviderSettings(plugin.settings).availableModes).toEqual([
      { id: 'build', name: 'Build' },
      { description: 'Planning-first agent', id: 'plan', name: 'Plan' },
    ]);
    expect(plugin.settings.providerConfigs.opencode.selectedMode).toBe('plan');
    expect((runtime as any).currentSessionModeId).toBe('build');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(refreshModelSelector).toHaveBeenCalledTimes(1);
  });

  it('seeds the OpenCode selected mode when no explicit mode has been saved yet', async () => {
    const plugin = createMockPlugin({
      settings: {
        providerConfigs: {
          opencode: {
            availableModes: [],
            selectedMode: '',
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);

    await (runtime as any).syncSessionModeState({
      currentModeId: OPENCODE_BUILD_MODE_ID,
    });

    expect(plugin.settings.providerConfigs.opencode.selectedMode).toBe(OPENCODE_YOLO_MODE_ID);
  });

  it('defaults OpenCode mode selection to the managed YOLO mode before ACP mode discovery finishes', () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'yolo',
        providerConfigs: {
          opencode: {
            availableModes: [],
            selectedMode: '',
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot').mockReturnValue(plugin.settings);

    expect((runtime as any).resolveSelectedModeId()).toBe(OPENCODE_YOLO_MODE_ID);
  });

  it('falls back to the managed YOLO mode when a saved custom mode is not managed by Claudian', () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'yolo',
        providerConfigs: {
          opencode: {
            availableModes: [],
            selectedMode: 'compaction',
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot').mockReturnValue(plugin.settings);

    expect((runtime as any).resolveSelectedModeId()).toBe(OPENCODE_YOLO_MODE_ID);
  });

  it('prefers managed YOLO/safe/plan modes over auxiliary OpenCode primary modes for the main toolbar', () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'yolo',
        providerConfigs: {
          opencode: {
            availableModes: [
              { id: OPENCODE_BUILD_MODE_ID, name: 'build' },
              { id: 'compaction', name: 'compaction' },
              { id: OPENCODE_SAFE_MODE_ID, name: 'claudian-safe' },
              { id: 'plan', name: 'plan' },
            ],
            selectedMode: '',
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot').mockReturnValue(plugin.settings);

    expect((runtime as any).resolveSelectedModeId()).toBe(OPENCODE_YOLO_MODE_ID);
  });

  it('maps shared safe mode onto the managed OpenCode safe agent', () => {
    const plugin = createMockPlugin({
      settings: {
        permissionMode: 'normal',
        providerConfigs: {
          opencode: {
            availableModes: [
              { id: OPENCODE_YOLO_MODE_ID, name: 'YOLO' },
              { id: OPENCODE_SAFE_MODE_ID, name: 'Safe' },
              { id: 'plan', name: 'Plan' },
            ],
            selectedMode: OPENCODE_YOLO_MODE_ID,
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot').mockReturnValue(plugin.settings);

    expect((runtime as any).resolveSelectedModeId()).toBe(OPENCODE_SAFE_MODE_ID);
  });

  it('syncs managed OpenCode safe mode back through the permission-mode callback', async () => {
    const plugin = createMockPlugin({
      settings: {
        providerConfigs: {
          opencode: {
            availableModes: [],
            selectedMode: '',
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    const syncCallback = jest.fn();

    runtime.setPermissionModeSyncCallback(syncCallback);

    await (runtime as any).syncSessionModeState({
      currentModeId: OPENCODE_SAFE_MODE_ID,
    });

    expect(syncCallback).toHaveBeenCalledWith('normal');
  });

  it('maps the legacy build alias back through the permission-mode callback as YOLO', async () => {
    const runtime = new OpencodeChatRuntime(createMockPlugin());
    const syncCallback = jest.fn();

    runtime.setPermissionModeSyncCallback(syncCallback);

    await (runtime as any).syncSessionModeState({
      currentModeId: OPENCODE_BUILD_MODE_ID,
    });

    expect(syncCallback).toHaveBeenCalledWith('yolo');
  });

  it('summarizes workflow approval prompts with tool metadata', async () => {
    const runtime = new OpencodeChatRuntime(createMockPlugin());
    const approvalCallback = jest.fn().mockResolvedValue('allow');

    runtime.setApprovalCallback(approvalCallback);

    await (runtime as any).handlePermissionRequest({
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'approve-now' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'other',
        rawInput: {
          tools: [
            { name: 'bash', args: JSON.stringify({ title: 'npm test' }) },
            { name: 'edit', args: JSON.stringify({ title: 'src/app.ts' }) },
            { name: 'read', args: '{}' },
            { name: 'glob', args: '{}' },
          ],
        },
        title: 'workflow_tool_approval',
        toolCallId: 'tool-2',
      },
    });

    expect(approvalCallback).toHaveBeenCalledWith(
      'Workflow Approval',
      {
        tools: [
          { args: JSON.stringify({ title: 'npm test' }), name: 'bash' },
          { args: JSON.stringify({ title: 'src/app.ts' }), name: 'edit' },
          { args: '{}', name: 'read' },
          { args: '{}', name: 'glob' },
        ],
      },
      'Pre-approve workflow tools for this session: bash: npm test, edit: src/app.ts, read +1 more.',
      {
        decisionOptions: [
          { decision: 'allow', label: 'Allow once', value: 'approve-now' },
        ],
        decisionReason: 'Session-level workflow approval requested',
      },
    );
  });

  it('preserves the explicit user model selection when the session reports its current model', async () => {
    const refreshModelSelector = jest.fn();
    const plugin = createMockPlugin({
      getAllViews: jest.fn().mockReturnValue([{ refreshModelSelector }]),
      settings: {
        effortLevel: 'high',
        model: 'opencode:anthropic/claude-sonnet-4',
        providerConfigs: {
          opencode: {
            discoveredModels: [
              { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
              { label: 'Anthropic/Claude Sonnet 4 (high)', rawId: 'anthropic/claude-sonnet-4/high' },
            ],
            preferredThinkingByModel: {
              'anthropic/claude-sonnet-4': 'high',
            },
            visibleModels: ['anthropic/claude-sonnet-4'],
          },
        },
        savedProviderEffort: {
          opencode: 'high',
        },
        savedProviderModel: {
          opencode: 'opencode:anthropic/claude-sonnet-4',
        },
        settingsProvider: 'opencode',
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    jest.spyOn(ProviderRegistry, 'resolveSettingsProviderId').mockReturnValue('opencode');
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot').mockReturnValue(plugin.settings);

    await (runtime as any).syncSessionModelState({
      configOptions: [{
        currentValue: 'anthropic/claude-sonnet-4',
        id: 'model',
        name: 'Model',
        options: [
          { name: 'Anthropic/Claude Sonnet 4', value: 'anthropic/claude-sonnet-4' },
          { name: 'Anthropic/Claude Sonnet 4 (high)', value: 'anthropic/claude-sonnet-4/high' },
        ],
        type: 'select',
      }],
    });

    expect(plugin.settings.providerConfigs.opencode.preferredThinkingByModel).toEqual({
      'anthropic/claude-sonnet-4': 'high',
    });
    expect(plugin.settings.savedProviderModel.opencode).toBe('opencode:anthropic/claude-sonnet-4');
    expect(plugin.settings.savedProviderEffort.opencode).toBe('high');
    expect(plugin.settings.model).toBe('opencode:anthropic/claude-sonnet-4');
    expect(plugin.settings.effortLevel).toBe('high');
    expect((runtime as any).resolveSelectedRawModelId()).toBe('anthropic/claude-sonnet-4');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(refreshModelSelector).not.toHaveBeenCalled();
  });

  it('syncs detached ACP thought-level options into OpenCode provider state', async () => {
    const refreshModelSelector = jest.fn();
    const plugin = createMockPlugin({
      getAllViews: jest.fn().mockReturnValue([{ refreshModelSelector }]),
      settings: {
        model: 'opencode:deepseek/deepseek-v4-pro',
        providerConfigs: {
          opencode: {
            discoveredModels: [],
            preferredThinkingByModel: {},
            visibleModels: ['deepseek/deepseek-v4-pro'],
          },
        },
        settingsProvider: 'opencode',
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    jest.spyOn(ProviderRegistry, 'resolveSettingsProviderId').mockReturnValue('opencode');

    await (runtime as any).syncSessionModelState({
      configOptions: [
        {
          category: 'model',
          currentValue: 'deepseek/deepseek-v4-pro',
          id: 'model',
          name: 'Model',
          options: [
            { name: 'DeepSeek/DeepSeek V4 Pro', value: 'deepseek/deepseek-v4-pro' },
          ],
          type: 'select',
        },
        {
          category: 'thought_level',
          currentValue: 'low',
          id: 'effort',
          name: 'Effort',
          options: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium' },
            { name: 'High', value: 'high' },
            { name: 'Max', value: 'max' },
          ],
          type: 'select',
        },
      ],
    });

    expect(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel).toEqual({
      'deepseek/deepseek-v4-pro': [
        { label: 'Low', value: 'low' },
        { label: 'Medium', value: 'medium' },
        { label: 'High', value: 'high' },
        { label: 'Max', value: 'max' },
      ],
    });
    expect(plugin.settings.providerConfigs.opencode.preferredThinkingByModel).toEqual({
      'deepseek/deepseek-v4-pro': 'low',
    });
    expect(plugin.settings.providerConfigs.opencode.thinkingOptionsByModel).toEqual({
      'deepseek/deepseek-v4-pro': [
        { label: 'Low', value: 'low' },
        { label: 'Medium', value: 'medium' },
        { label: 'High', value: 'high' },
        { label: 'Max', value: 'max' },
      ],
    });
    expect(plugin.settings.effortLevel).toBe('low');
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(refreshModelSelector).toHaveBeenCalledTimes(1);
  });

  it('warms selected model metadata by switching ACP model config', async () => {
    const plugin = createMockPlugin({
      settings: {
        model: 'opencode:deepseek/deepseek-v4-pro',
        providerConfigs: {
          opencode: {
            discoveredModels: [
              { label: 'DeepSeek/DeepSeek V4 Pro', rawId: 'deepseek/deepseek-v4-pro' },
            ],
            preferredThinkingByModel: {},
            visibleModels: ['deepseek/deepseek-v4-pro'],
          },
        },
        settingsProvider: 'opencode',
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    const setConfigOption = jest.fn().mockResolvedValue({
      configOptions: [
        {
          category: 'model',
          currentValue: 'deepseek/deepseek-v4-pro',
          id: 'model',
          name: 'Model',
          options: [
            { name: 'DeepSeek/DeepSeek V4 Pro', value: 'deepseek/deepseek-v4-pro' },
          ],
          type: 'select',
        },
        {
          category: 'thought_level',
          currentValue: 'low',
          id: 'effort',
          name: 'Effort',
          options: [
            { name: 'Low', value: 'low' },
            { name: 'High', value: 'high' },
          ],
          type: 'select',
        },
      ],
    });
    (runtime as any).connection = { setConfigOption };
    (runtime as any).sessionId = 'session-1';
    jest.spyOn(runtime, 'ensureReady').mockResolvedValue(true);
    jest.spyOn(ProviderRegistry, 'resolveSettingsProviderId').mockReturnValue('opencode');

    await expect(runtime.warmModelMetadata('opencode:deepseek/deepseek-v4-pro')).resolves.toBe(true);

    expect(setConfigOption).toHaveBeenCalledWith({
      configId: 'model',
      sessionId: 'session-1',
      type: 'select',
      value: 'deepseek/deepseek-v4-pro',
    });
    expect(plugin.settings.providerConfigs.opencode.thinkingOptionsByModel).toEqual({
      'deepseek/deepseek-v4-pro': [
        { label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
    });
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('applies selected OpenCode effort through the detached ACP effort option', async () => {
    const plugin = createMockPlugin({
      settings: {
        effortLevel: 'high',
        model: 'opencode:deepseek/deepseek-v4-pro',
        providerConfigs: {
          opencode: {
            discoveredModels: [
              { label: 'DeepSeek/DeepSeek V4 Pro', rawId: 'deepseek/deepseek-v4-pro' },
            ],
            thinkingOptionsByModel: {
              'deepseek/deepseek-v4-pro': [
                { label: 'Low', value: 'low' },
                { label: 'High', value: 'high' },
              ],
            },
            visibleModels: ['deepseek/deepseek-v4-pro'],
          },
        },
        settingsProvider: 'opencode',
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    const setConfigOption = jest.fn().mockResolvedValue({
      configOptions: [{
        category: 'thought_level',
        currentValue: 'high',
        id: 'effort',
        name: 'Effort',
        options: [
          { name: 'Low', value: 'low' },
          { name: 'High', value: 'high' },
        ],
        type: 'select',
      }],
    });
    (runtime as any).connection = { setConfigOption };
    (runtime as any).currentSessionEffortConfigId = 'effort';
    (runtime as any).currentSessionEffortValue = 'low';
    (runtime as any).currentSessionEffortValues = new Set(['low', 'high']);
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot').mockReturnValue(plugin.settings);

    await (runtime as any).applySelectedEffort('session-1');

    expect(setConfigOption).toHaveBeenCalledWith({
      configId: 'effort',
      sessionId: 'session-1',
      type: 'select',
      value: 'high',
    });
  });

  it('exposes the active display model for auxiliary OpenCode tasks', () => {
    const plugin = createMockPlugin({
      settings: {
        effortLevel: 'high',
        model: 'opencode:anthropic/claude-sonnet-4',
        providerConfigs: {
          opencode: {
            discoveredModels: [
              { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
              { label: 'Anthropic/Claude Sonnet 4 (high)', rawId: 'anthropic/claude-sonnet-4/high' },
            ],
            preferredThinkingByModel: {
              'anthropic/claude-sonnet-4': 'high',
            },
            visibleModels: ['anthropic/claude-sonnet-4'],
          },
        },
        savedProviderModel: {
          opencode: 'opencode:anthropic/claude-sonnet-4',
        },
        settingsProvider: 'opencode',
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);

    jest.spyOn(ProviderRegistry, 'resolveSettingsProviderId').mockReturnValue('opencode');
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot').mockReturnValue(plugin.settings);

    expect(runtime.getAuxiliaryModel()).toBe('opencode:anthropic/claude-sonnet-4');
  });
});
