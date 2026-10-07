import * as path from 'node:path';

import { buildGrokRuntimeEnv } from '@/providers/grok/runtime/GrokRuntimeEnvironment';

describe('buildGrokRuntimeEnv', () => {
  describe('folder trust', () => {
    beforeEach(() => {
      jest.replaceProperty(process, 'env', { ...process.env });
      delete process.env.GROK_FOLDER_TRUST;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('allows native vault skill discovery without changing the host environment', () => {
      const env = buildGrokRuntimeEnv({}, 'grok');

      expect(env.GROK_FOLDER_TRUST).toBe('0');
      expect(process.env.GROK_FOLDER_TRUST).toBeUndefined();
    });

    it.each([
      { processValue: '1', sharedValue: undefined, providerValue: undefined, expected: '1' },
      { processValue: undefined, sharedValue: '1', providerValue: undefined, expected: '1' },
      { processValue: undefined, sharedValue: undefined, providerValue: '1', expected: '1' },
      { processValue: '0', sharedValue: '1', providerValue: undefined, expected: '1' },
      { processValue: '1', sharedValue: '1', providerValue: '0', expected: '0' },
    ])('honors explicit overrides: %j', ({ processValue, sharedValue, providerValue, expected }) => {
      if (processValue !== undefined) process.env.GROK_FOLDER_TRUST = processValue;

      const env = buildGrokRuntimeEnv({
        sharedEnvironmentVariables: sharedValue === undefined ? '' : `GROK_FOLDER_TRUST=${sharedValue}`,
        providerConfigs: {
          grok: {
            environmentVariables: providerValue === undefined ? '' : `GROK_FOLDER_TRUST=${providerValue}`,
          },
        },
      }, 'grok');

      expect(env.GROK_FOLDER_TRUST).toBe(expected);
      expect(process.env.GROK_FOLDER_TRUST).toBe(processValue);
    });
  });

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
    }, process.execPath);
    delete process.env.GROK_P1_PROCESS_ONLY;

    expect(env.GROK_P1_PROCESS_ONLY).toBe('from-process');
    expect(env.HTTPS_PROXY).toBe('https://proxy.example.com');
    expect(env.CUSTOM_API_KEY).toBe('provider-secret');
    expect(env.PATH?.split(path.delimiter)).toContain('/provider/bin');
    expect(env.PATH?.split(path.delimiter)).toContain(path.dirname(process.execPath));
  });

  it('applies provider over shared over process precedence for duplicate keys', () => {
    process.env.GROK_PRECEDENCE = 'from-process';
    process.env.GROK_SHARED_PRECEDENCE = 'from-process';
    try {
      const env = buildGrokRuntimeEnv({
        providerConfigs: {
          grok: {
            environmentVariables: 'GROK_PRECEDENCE=from-provider',
          },
        },
        sharedEnvironmentVariables: [
          'GROK_PRECEDENCE=from-shared',
          'GROK_SHARED_PRECEDENCE=from-shared',
        ].join('\n'),
      }, process.execPath);

      expect(env.GROK_PRECEDENCE).toBe('from-provider');
      expect(env.GROK_SHARED_PRECEDENCE).toBe('from-shared');
    } finally {
      delete process.env.GROK_PRECEDENCE;
      delete process.env.GROK_SHARED_PRECEDENCE;
    }
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
