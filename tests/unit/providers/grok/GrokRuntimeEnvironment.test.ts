import { buildGrokRuntimeEnv } from '@/providers/grok/runtime/GrokRuntimeEnvironment';

describe('buildGrokRuntimeEnv', () => {
  it('disables trace upload by default and preserves explicit overrides', () => {
    const withDefault = buildGrokRuntimeEnv({
      providerConfigs: {
        grok: {
          environmentVariables: 'GROK_MODEL=grok-4.5',
        },
      },
    }, '/usr/local/bin/grok');

    expect(withDefault.GROK_TELEMETRY_TRACE_UPLOAD).toBe('0');
    expect(withDefault.GROK_MODEL).toBe('grok-4.5');
    expect(withDefault.PATH).toContain('/usr/local/bin');

    const withOverride = buildGrokRuntimeEnv({
      providerConfigs: {
        grok: {
          environmentVariables: 'GROK_TELEMETRY_TRACE_UPLOAD=1',
        },
      },
    }, '/usr/local/bin/grok');

    expect(withOverride.GROK_TELEMETRY_TRACE_UPLOAD).toBe('1');
  });

  it('sets GROK_SANDBOX from safeMode when the user did not set it', () => {
    const env = buildGrokRuntimeEnv({
      providerConfigs: {
        grok: {
          safeMode: 'read-only',
          environmentVariables: '',
        },
      },
    }, '/usr/local/bin/grok');

    expect(env.GROK_SANDBOX).toBe('read-only');
  });

  it('does not override an explicit GROK_SANDBOX from provider environment', () => {
    const env = buildGrokRuntimeEnv({
      providerConfigs: {
        grok: {
          safeMode: 'workspace',
          environmentVariables: 'GROK_SANDBOX=strict',
        },
      },
    }, '/usr/local/bin/grok');

    expect(env.GROK_SANDBOX).toBe('strict');
  });
});
