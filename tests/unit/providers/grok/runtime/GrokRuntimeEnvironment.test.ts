import { buildGrokRuntimeEnv } from '@/providers/grok/runtime/GrokRuntimeEnvironment';

describe('buildGrokRuntimeEnv', () => {
  it('merges process, shared, and provider scope with an enhanced provider PATH', () => {
    process.env.GROK_P1_PROCESS_ONLY = 'from-process';
    const env = buildGrokRuntimeEnv({
      providerConfigs: {
        grok: {
          environmentVariables: [
            'PATH=/provider/bin',
            'CUSTOM_API_KEY=provider-secret',
          ].join('\n'),
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    }, '/resolved/bin/grok');
    delete process.env.GROK_P1_PROCESS_ONLY;

    expect(env.GROK_P1_PROCESS_ONLY).toBe('from-process');
    expect(env.HTTPS_PROXY).toBe('https://proxy.example.com');
    expect(env.CUSTOM_API_KEY).toBe('provider-secret');
    expect(env.PATH?.split(pathDelimiter())).toContain('/provider/bin');
  });

  it('does not source shell expressions or force Grok config, auth, model, or telemetry', () => {
    const env = buildGrokRuntimeEnv({
      providerConfigs: {
        grok: {
          environmentVariables: 'GROK_HOME=$HOME/custom\nXAI_API_KEY=user-provided',
        },
      },
    }, 'grok');

    expect(env.GROK_HOME).toBe('$HOME/custom');
    expect(env.XAI_API_KEY).toBe('user-provided');
    expect(env).not.toHaveProperty('GROK_DEFAULT_MODEL');
    expect(env).not.toHaveProperty('GROK_TELEMETRY_DISABLED');
    expect(env).not.toHaveProperty('GROK_CONFIG');
    expect(env).not.toHaveProperty('GROK_TOKEN');
  });
});

function pathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':';
}
