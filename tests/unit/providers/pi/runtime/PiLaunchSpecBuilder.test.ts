import { DEFAULT_PI_PROVIDER_SETTINGS, type PiProviderSettings } from '@/providers/pi/config';
import { buildPiLaunchSpec } from '@/providers/pi/runtime/PiLaunchSpecBuilder';

const baseSettings: PiProviderSettings = {
  ...DEFAULT_PI_PROVIDER_SETTINGS,
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: true,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  sessionEnvironmentHash: '',
  visibleModels: [],
};

describe('PiLaunchSpecBuilder', () => {
  it('maps a WSL resume file and includes the resolved distro in process compatibility', () => {
    const params = {
      command: 'pi', cwd: 'C:\\Vault', settings: baseSettings,
      providerState: { sessionFile: '\\\\wsl$\\Ubuntu\\home\\me\\session.jsonl' },
      executionTarget: { method: 'wsl' as const, platformFamily: 'unix' as const, platformOs: 'linux' as const, distroName: 'Ubuntu' },
    };
    const launch = buildPiLaunchSpec(params);
    expect(launch.sessionTarget).toBe('/home/me/session.jsonl');
    expect(launch.args).toContain('/home/me/session.jsonl');
    expect(buildPiLaunchSpec({ ...params, providerState: null, executionTarget: { ...params.executionTarget, distroName: 'Debian' } }).processKey)
      .not.toBe(buildPiLaunchSpec({ ...params, providerState: null }).processKey);
  });

  it('builds main launch args with replacement system prompt and model flags', () => {
    expect(buildPiLaunchSpec({
      command: '/bin/pi',
      cwd: '/vault',
      model: 'pi:anthropic/claude/sonnet',
      providerState: { sessionFile: '/tmp/session.jsonl' },
      settings: baseSettings,
      systemPrompt: 'System prompt',
      thinkingLevel: 'high',
    }).args).toEqual([
      '--mode',
      'rpc',
      '--system-prompt',
      'System prompt',
      '--session',
      '/tmp/session.jsonl',
      '--provider',
      'anthropic',
      '--model',
      'claude/sonnet',
      '--thinking',
      'high',
    ]);
  });

  it('adds no-session and read-only tools when requested', () => {
    expect(buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      noSession: true,
      readOnlyTools: true,
      settings: baseSettings,
    }).args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--tools',
      'read,grep,find,ls',
    ]);
  });

  it('does not resume from detached previous sessions', () => {
    expect(buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      providerState: {
        previousSessions: [{
          leafEntryId: 'assistant-1',
          sessionFile: '/tmp/previous.jsonl',
          sessionId: 'previous-session',
        }],
      },
      settings: baseSettings,
    }).args).toEqual(['--mode', 'rpc']);
  });

  it('passes max thinking through to Pi', () => {
    expect(buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      noSession: true,
      settings: baseSettings,
      thinkingLevel: 'max',
    }).args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--thinking',
      'max',
    ]);
  });

  it('uses no-tools for passive auxiliary launches', () => {
    expect(buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      noSession: true,
      noTools: true,
      settings: baseSettings,
    }).args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--no-tools',
    ]);
  });

  it('includes full runtime environment text in the process key', () => {
    const first = buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      envText: 'PATH=/first',
      settings: baseSettings,
    });
    const second = buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      envText: 'PATH=/second',
      settings: baseSettings,
    });

    expect(first.processKey).not.toBe(second.processKey);
  });

  it('keeps session identity separate from process compatibility', () => {
    const first = buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      providerState: { sessionFile: '/tmp/first.jsonl' },
      settings: baseSettings,
      systemPrompt: '--session',
    });
    const second = buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      providerState: { sessionFile: '/tmp/second.jsonl' },
      settings: baseSettings,
      systemPrompt: '--session',
    });

    expect(first.processKey).toBe(second.processKey);
    expect(JSON.parse(first.processKey).args).toEqual([
      '--mode',
      'rpc',
      '--system-prompt',
      '--session',
    ]);
    expect(first.sessionTarget).toBe('/tmp/first.jsonl');
    expect(second.sessionTarget).toBe('/tmp/second.jsonl');
  });
});
