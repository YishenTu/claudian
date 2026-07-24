import * as sdkModule from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { probeRuntimeCommands } from '@/providers/claude/commands/probeRuntimeCommands';

const sdkMock = sdkModule as unknown as {
  getLastResponse: () => {
    supportedCommands: jest.Mock;
  } | null;
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  setMockSupportedCommands: (commands: Array<{ name: string; description: string; argumentHint?: string }>) => void;
  setMockSupportedCommandsImplementation: (
    implementation: () => Promise<Array<{
      name: string;
      description: string;
      argumentHint?: string;
    }>>,
  ) => void;
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

function createMockPlugin(settings: Record<string, unknown> = {}): ProviderHost {
  return {
    app: {},
    settings,
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/mock/claude'),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
  } as unknown as ProviderHost;
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
    expect(sdkMock.getLastOptions()?.settingSources).toEqual(['project', 'local']);
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
    expect(options?.settingSources).toEqual(['user', 'project', 'local']);
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

  it('aborts an in-flight SDK probe when its caller is cancelled', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'probe-session' },
    ], { appendResult: false });
    sdkMock.setMockSupportedCommandsImplementation(
      () => new Promise(() => undefined),
    );
    const abortController = new AbortController();

    const probe = probeRuntimeCommands(
      createMockPlugin(),
      abortController.signal,
    );
    for (
      let i = 0;
      i < 10 && !sdkMock.getLastResponse()?.supportedCommands.mock.calls.length;
      i++
    ) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(sdkMock.getLastResponse()?.supportedCommands).toHaveBeenCalledTimes(1);

    abortController.abort();
    expect(sdkMock.getLastOptions()?.abortController?.signal.aborted).toBe(true);

    await expect(probe).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('normalizes a non-Error abort reason before rejecting', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'probe-session' },
    ], { appendResult: false });
    sdkMock.setMockSupportedCommandsImplementation(
      () => new Promise(() => undefined),
    );
    const abortController = new AbortController();

    const probe = probeRuntimeCommands(
      createMockPlugin(),
      abortController.signal,
    );
    for (
      let i = 0;
      i < 10 && !sdkMock.getLastResponse()?.supportedCommands.mock.calls.length;
      i++
    ) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    abortController.abort('caller cancelled');

    await expect(probe).rejects.toMatchObject({
      message: 'Claude command discovery aborted',
      cause: 'caller cancelled',
    });
  });
});
