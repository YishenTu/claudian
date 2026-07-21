import type { ProviderHost } from '@/core/providers/ProviderHost';
import {
  buildGrokCatalogFingerprint,
  type GrokCatalogCommandRequest,
  type GrokCatalogCommandResult,
  type GrokCatalogCommandRunner,
  GrokModelCatalogService,
  parseGrokModelsOutput,
  SpawnGrokCatalogCommandRunner,
} from '@/providers/grok/runtime/GrokModelCatalogService';

function makeHost(enabled = true): ProviderHost {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/vault',
        },
      },
    },
    getResolvedProviderCliPath: jest.fn(async () => '/opt/grok/bin/grok'),
    settings: {
      providerConfigs: {
        grok: {
          enabled,
          environmentVariables: 'XAI_API_KEY=super-secret\nCUSTOM_MODEL_SOURCE=enabled',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example',
    },
  } as unknown as ProviderHost;
}

function makeRunner(
  modelsResult: GrokCatalogCommandResult,
  versionResult: GrokCatalogCommandResult = {
    exitCode: 0,
    stdout: 'grok 0.2.106\n',
  },
): GrokCatalogCommandRunner & { requests: GrokCatalogCommandRequest[] } {
  const requests: GrokCatalogCommandRequest[] = [];
  return {
    requests,
    run: jest.fn(async (request) => {
      requests.push(request);
      return request.args[0] === '--version' ? versionResult : modelsResult;
    }),
  };
}

describe('parseGrokModelsOutput', () => {
  it('parses account prefixes, a default, multiple aliases, columns, and unknown lines', () => {
    const output = [
      'Authenticated as user@example.com',
      'Default model: kimi-coding',
      'Unrelated status: ready',
      'Available models:',
      '  kimi-coding       Kimi K2.5       (default)',
      '  glm-coding        GLM Coding      custom-column',
      '  deepseek/coder-v3 DeepSeek Coder  another column',
      '  Note: aliases may be configured by the user',
      '  status=internal must-not-be-parsed',
      'Unknown section:',
      '  must-not-be-parsed',
    ].join('\n');

    expect(parseGrokModelsOutput(output)).toEqual({
      defaultModelId: 'kimi-coding',
      models: [
        {
          displayName: 'kimi-coding',
          rawId: 'kimi-coding',
          reasoningEfforts: [],
          supportsReasoning: false,
        },
        {
          displayName: 'glm-coding',
          rawId: 'glm-coding',
          reasoningEfforts: [],
          supportsReasoning: false,
        },
        {
          displayName: 'deepseek/coder-v3',
          rawId: 'deepseek/coder-v3',
          reasoningEfforts: [],
          supportsReasoning: false,
        },
      ],
    });
  });

  it('strips ANSI, accepts CRLF and whitespace, and ignores duplicate/default markers', () => {
    const output = [
      '\u001b[32mDefault model:\u001b[0m   grok-code-fast-1  ',
      '  Available models:  ',
      '    * grok-code-fast-1   (default)',
      '    - custom-alias       extra-column',
      '      custom-alias       duplicate',
      '',
    ].join('\r\n');

    expect(parseGrokModelsOutput(output)).toEqual({
      defaultModelId: 'grok-code-fast-1',
      models: [
        expect.objectContaining({ rawId: 'grok-code-fast-1' }),
        expect.objectContaining({ rawId: 'custom-alias' }),
      ],
    });
  });

  it('returns an empty catalog for empty or unrelated output', () => {
    expect(parseGrokModelsOutput('')).toEqual({ defaultModelId: null, models: [] });
    expect(parseGrokModelsOutput('Authenticated\nNo catalog available')).toEqual({
      defaultModelId: null,
      models: [],
    });
  });
});

describe('GrokModelCatalogService', () => {
  it('runs resolved-grok models with the provider runtime environment', async () => {
    const runner = makeRunner({
      exitCode: 0,
      stdout: 'Default model: kimi-coding\nAvailable models:\n  kimi-coding\n',
    });
    const service = new GrokModelCatalogService(makeHost(), { runner });

    const result = await service.discoverCatalog();

    if (result.kind !== 'completed') {
      throw new Error('Expected completed Grok model discovery');
    }
    expect(result).toMatchObject({
      defaultModelId: 'kimi-coding',
      kind: 'completed',
      models: [expect.objectContaining({ rawId: 'kimi-coding' })],
    });
    expect(result.fingerprint).toMatch(/^1:[a-f0-9]{64}$/);
    expect(result.fingerprint).not.toContain('super-secret');
    expect(runner.requests.map(request => request.args)).toEqual([
      ['--version'],
      ['models'],
    ]);
    expect(runner.requests[1]).toMatchObject({
      command: '/opt/grok/bin/grok',
      cwd: '/vault',
    });
    expect(runner.requests[1].env).toMatchObject({
      CUSTOM_MODEL_SOURCE: 'enabled',
      HTTPS_PROXY: 'https://proxy.example',
      XAI_API_KEY: 'super-secret',
    });
  });

  it('skips without resolving or launching when Grok is disabled', async () => {
    const host = makeHost(false);
    const runner = makeRunner({ exitCode: 0, stdout: '' });

    await expect(new GrokModelCatalogService(host, { runner }).discoverCatalog()).resolves.toEqual({
      kind: 'skipped',
      reason: 'provider-disabled',
    });
    expect(host.getResolvedProviderCliPath).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('returns concise diagnostics for an empty catalog without exposing output', async () => {
    const rawOutput = 'Account user@example.com token=super-secret';
    const runner = makeRunner({ exitCode: 0, stdout: rawOutput });

    const result = await new GrokModelCatalogService(makeHost(), { runner }).discoverCatalog();

    expect(result).toMatchObject({
      diagnostics: 'Grok models returned no available models',
      kind: 'completed',
      models: [],
    });
    expect(JSON.stringify(result)).not.toContain(rawOutput);
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('returns concise diagnostics for non-zero exit without exposing stdout or stderr', async () => {
    const runner = makeRunner({
      exitCode: 17,
      stdout: 'secret stdout',
    });

    const result = await new GrokModelCatalogService(makeHost(), { runner }).discoverCatalog();

    expect(result).toMatchObject({
      diagnostics: 'Grok models exited with code 17',
      kind: 'completed',
      models: [],
    });
    expect(JSON.stringify(result)).not.toContain('secret stdout');
  });

  it('returns concise diagnostics on timeout', async () => {
    const runner = makeRunner({
      exitCode: null,
      stdout: 'private partial output',
      termination: 'timeout',
    });

    const result = await new GrokModelCatalogService(makeHost(), { runner }).discoverCatalog();

    expect(result).toMatchObject({
      diagnostics: 'Grok models timed out',
      kind: 'completed',
      models: [],
    });
    expect(JSON.stringify(result)).not.toContain('private partial output');
  });

  it('fingerprints CLI identity/version and environment key names, never values', () => {
    const first = buildGrokCatalogFingerprint({
      command: '/opt/grok/bin/grok',
      environmentKeys: ['XAI_API_KEY', 'CUSTOM_MODEL_SOURCE'],
      version: 'grok 0.2.106',
    });
    const sameNamesDifferentOrder = buildGrokCatalogFingerprint({
      command: '/opt/grok/bin/grok',
      environmentKeys: ['CUSTOM_MODEL_SOURCE', 'XAI_API_KEY'],
      version: 'grok 0.2.106',
    });
    const upgraded = buildGrokCatalogFingerprint({
      command: '/opt/grok/bin/grok',
      environmentKeys: ['CUSTOM_MODEL_SOURCE', 'XAI_API_KEY'],
      version: 'grok 0.2.107',
    });

    expect(first).toBe(sameNamesDifferentOrder);
    expect(first).not.toBe(upgraded);
    expect(first).toMatch(/^1:[a-f0-9]{64}$/);
  });
});

describe('SpawnGrokCatalogCommandRunner', () => {
  it('terminates a command at the configured timeout', async () => {
    const result = await new SpawnGrokCatalogCommandRunner().run({
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      command: process.execPath,
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 20,
    });

    expect(result).toEqual({
      exitCode: null,
      stdout: '',
      termination: 'timeout',
    });
  });
});
