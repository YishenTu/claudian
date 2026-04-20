import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
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

  it('creates a session on demand when commands are requested before a session exists', async () => {
    const runtime = new OpencodeChatRuntime(createMockPlugin());
    const commands = [{ id: 'acp:review', name: 'review', content: '', source: 'sdk' }];

    (runtime as any).ready = true;
    (runtime as any).createSession = jest.fn(async () => {
      (runtime as any).sessionId = 'session-1';
      (runtime as any).loadedSessionId = 'session-1';
      (runtime as any).setSupportedCommands(commands);
      return 'session-1';
    });

    await expect(runtime.getSupportedCommands()).resolves.toEqual(commands);
    expect((runtime as any).createSession).toHaveBeenCalledTimes(1);
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
      currentModeId: 'build',
    });

    expect(plugin.settings.providerConfigs.opencode.selectedMode).toBe('build');
  });

  it('defaults OpenCode mode selection to build before ACP mode discovery finishes', () => {
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
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot').mockReturnValue(plugin.settings);

    expect((runtime as any).resolveSelectedModeId()).toBe('build');
  });

  it('preserves a saved custom mode until ACP mode discovery can validate it', () => {
    const plugin = createMockPlugin({
      settings: {
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

    expect((runtime as any).resolveSelectedModeId()).toBe('compaction');
  });

  it('prefers build/plan over auxiliary OpenCode primary modes for the main toolbar', () => {
    const plugin = createMockPlugin({
      settings: {
        providerConfigs: {
          opencode: {
            availableModes: [
              { id: 'build', name: 'build' },
              { id: 'compaction', name: 'compaction' },
              { id: 'plan', name: 'plan' },
            ],
            selectedMode: '',
          },
        },
      },
    });
    const runtime = new OpencodeChatRuntime(plugin);
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot').mockReturnValue(plugin.settings);

    expect((runtime as any).resolveSelectedModeId()).toBe('build');
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
    expect((runtime as any).resolveSelectedRawModelId()).toBe('anthropic/claude-sonnet-4/high');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(refreshModelSelector).not.toHaveBeenCalled();
  });
});
