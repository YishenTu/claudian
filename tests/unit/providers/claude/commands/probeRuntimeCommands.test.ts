import * as sdkModule from '@anthropic-ai/claude-agent-sdk';

import type ClaudianPlugin from '@/main';
import { probeRuntimeCommands } from '@/providers/claude/commands/probeRuntimeCommands';

const sdkMock = sdkModule as unknown as {
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  setMockSupportedCommands: (commands: Array<{ name: string; description: string; argumentHint?: string }>) => void;
  resetMockMessages: () => void;
  getLastOptions: () => sdkModule.Options | undefined;
};

jest.mock('@/utils/path', () => ({
  getVaultPath: jest.fn().mockReturnValue('/test/vault'),
}));

jest.mock('@/utils/env', () => ({
  parseEnvironmentVariables: jest.fn().mockReturnValue({ PATH: '/usr/bin' }),
  getEnhancedPath: jest.fn().mockReturnValue('/usr/bin:/mock/bin'),
  findNodeExecutable: jest.fn().mockReturnValue('/usr/bin/node'),
}));

function createMockPlugin(settings: Record<string, unknown> = {}): ClaudianPlugin {
  return {
    app: {},
    settings,
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/mock/claude'),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
  } as unknown as ClaudianPlugin;
}

describe('probeRuntimeCommands', () => {
  beforeEach(() => {
    sdkMock.resetMockMessages();
  });

  it('uses the same settingSources as the Claude runtime when user settings are disabled', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'probe-session' },
    ], { appendResult: false });
    sdkMock.setMockSupportedCommands([
      { name: 'commit', description: 'Create a commit', argumentHint: '' },
    ]);

    const commands = await probeRuntimeCommands(createMockPlugin({
      loadUserClaudeSettings: false,
    }));

    expect(commands).toEqual([{
      id: 'sdk:commit',
      name: 'commit',
      description: 'Create a commit',
      argumentHint: '',
      content: '',
      source: 'sdk',
    }]);
    expect(sdkMock.getLastOptions()?.settingSources).toEqual(['project']);
  });

  it('includes user settings in the probe when the runtime would include them', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'probe-session' },
    ], { appendResult: false });
    sdkMock.setMockSupportedCommands([]);

    await probeRuntimeCommands(createMockPlugin({
      loadUserClaudeSettings: true,
      enableChrome: true,
    }));

    const options = sdkMock.getLastOptions();
    expect(options?.settingSources).toEqual(['user', 'project']);
    expect(options?.extraArgs).toEqual({ chrome: null });
  });

  it('passes auto mode opt-in when Claude safe mode is auto', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'probe-session' },
    ], { appendResult: false });
    sdkMock.setMockSupportedCommands([]);

    await probeRuntimeCommands(createMockPlugin({
      providerConfigs: {
        claude: {
          safeMode: 'auto',
        },
      },
    }));

    expect(sdkMock.getLastOptions()?.extraArgs).toEqual({ 'enable-auto-mode': null });
  });
});
