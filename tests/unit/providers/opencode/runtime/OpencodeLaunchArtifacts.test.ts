import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildOpencodeManagedConfig,
  prepareOpencodeLaunchArtifacts,
} from '@/providers/opencode/runtime/OpencodeLaunchArtifacts';

describe('buildOpencodeManagedConfig', () => {
  it.each([1, 2] as const)('keeps user build approval rules under native v%s configuration', (nativeVersion) => {
    const config = buildOpencodeManagedConfig({
      agent: { build: { permission: { bash: 'ask', read: { '*.env': 'ask' } }, model: 'test/model' } },
      ...(nativeVersion === 2 ? { agents: { build: {
        model: 'test/model', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
      } } } : {}),
    }, [{ id: 'build', prompt: 'Main instructions' }], undefined, nativeVersion);
    expect(config).toMatchObject({
      agent: { build: {
        model: 'test/model', permission: { bash: 'ask', read: { '*.env': 'ask' } }, prompt: 'Main instructions',
      } },
      ...(nativeVersion === 2 ? { agents: { build: {
        model: 'test/model', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }], system: 'Main instructions',
      } } } : {}),
    });
  });

  it('leaves the build agent on its native prompt when no instructions are supplied', () => {
    expect(buildOpencodeManagedConfig({})).toEqual({
      $schema: 'https://opencode.ai/config.json',
      agent: {
        plan: { disable: true },
        build: {},
      },
    });
  });

  it('can create a dedicated aux agent and default it for the process', () => {
    expect(buildOpencodeManagedConfig(
      {},
      [{
        definition: {
          mode: 'primary',
          permission: {
            '*': 'deny',
            read: 'allow',
          },
        },
        id: 'claudian-aux-readonly',
        prompt: 'Read-only instructions',
      }],
      'claudian-aux-readonly',
    )).toEqual({
      $schema: 'https://opencode.ai/config.json',
      agent: {
        plan: { disable: true },
        'claudian-aux-readonly': {
          mode: 'primary',
          permission: {
            '*': 'deny',
            read: 'allow',
          },
          prompt: 'Read-only instructions',
        },
      },
      default_agent: 'claudian-aux-readonly',
    });
  });

  it.each([
    undefined,
    [{ id: 'claudian-aux-readonly', definition: { permission: { '*': 'deny' } } }],
  ])('disables the native plan agent while preserving user agent configuration', (managedAgents) => {
    const baseConfig = {
      agent: {
        plan: { disable: false, model: 'anthropic/claude-sonnet-4' },
        reviewer: { description: 'Review changes', mode: 'subagent' },
      },
      command: { discuss: { agent: 'plan', template: 'Discuss the change' } },
    };

    const config = buildOpencodeManagedConfig(
      baseConfig,
      managedAgents,
    );

    expect(config.agent).toMatchObject({
      plan: { disable: true, model: 'anthropic/claude-sonnet-4' },
      reviewer: { description: 'Review changes', mode: 'subagent' },
    });
    expect(config.command).toEqual(baseConfig.command);
    expect(baseConfig.agent.plan.disable).toBe(false);
  });

  it('merges the user config instead of replacing it', () => {
    expect(buildOpencodeManagedConfig({
      agent: {
        build: {
          model: 'openai/gpt-5',
          permission: {
            bash: 'ask',
            edit: 'ask',
          },
        },
      },
      default_agent: 'build',
      providers: {
        openai: {
          api_key: 'test-key',
        },
      },
      username: 'Existing',
    })).toEqual({
      $schema: 'https://opencode.ai/config.json',
      agent: {
        plan: { disable: true },
        build: {
          model: 'openai/gpt-5',
          permission: {
            bash: 'ask',
            edit: 'ask',
          },
        },
      },
      default_agent: 'build',
      providers: {
        openai: {
          api_key: 'test-key',
        },
      },
      username: 'Existing',
    });
  });
});

describe('prepareOpencodeLaunchArtifacts', () => {
  it('launches without instructions write, reference and keep no prompt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-prompts-'));
    const legacyPrompts = path.join(root, '.claudian', 'opencode', 'prompts');
    await fs.mkdir(legacyPrompts, { recursive: true });
    await fs.writeFile(path.join(legacyPrompts, 'main.md'), 'Stale instructions\n');
    try {
      const result = await prepareOpencodeLaunchArtifacts({
        workspaceRoot: root, runtimeEnv: { HOME: root, OPENCODE_DB: ':memory:' }, nativeVersion: 2,
        sessionToolsPluginPath: path.join(root, 'plugin.js'),
      });
      const stored = await fs.readFile(result.configPath, 'utf8');
      for (const text of [stored, result.configContent]) {
        expect(text).not.toMatch(/"(prompt|system)"/);
        expect(text).not.toContain('Stale instructions');
      }
      await expect(fs.access(legacyPrompts)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('inlines caller instructions only for the launched profile and keeps the shared file prompt-free', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-prompts-'));
    const base = { workspaceRoot: root, runtimeEnv: { HOME: root } };
    try {
      const main = await prepareOpencodeLaunchArtifacts({ ...base, systemPromptText: 'Main {file:./secret.txt} instructions' });
      const config = await fs.readFile(main.configPath, 'utf8');
      const [inline, title] = await Promise.all([
        prepareOpencodeLaunchArtifacts({ ...base, profile: 'readonly', systemPromptText: 'Inline edit instructions' }),
        prepareOpencodeLaunchArtifacts({ ...base, profile: 'passive', systemPromptText: 'Title instructions' }),
      ]);

      expect(inline.configPath).toBe(main.configPath);
      expect(await fs.readFile(main.configPath, 'utf8')).toBe(config);
      expect(config).not.toMatch(/"prompt"/);
      // Caller text is delivered literally; native config expansion must not resolve references inside it.
      expect(main.configContent).not.toContain('{file:');
      const agents = (result: { configContent: string }) => JSON.parse(result.configContent).agent;
      expect(agents(main).build.prompt).toBe('Main {file:./secret.txt} instructions');
      expect(agents(main)['claudian-inline-edit']).not.toHaveProperty('prompt');
      expect(agents(inline)['claudian-inline-edit'].prompt).toBe('Inline edit instructions');
      expect(agents(inline).build).not.toHaveProperty('prompt');
      expect(agents(title)['claudian-title'].prompt).toBe('Title instructions');
      expect(JSON.parse(inline.configContent).default_agent).toBe('claudian-inline-edit');
      expect(JSON.parse(title.configContent).default_agent).toBe('claudian-title');
      await expect(fs.access(path.join(root, '.claudian', 'opencode', 'prompts'))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('layers the managed prompt config on top of OPENCODE_CONFIG', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-artifacts-'));
    const baseConfigPath = path.join(tmpRoot, 'opencode.base.json');
    await fs.writeFile(baseConfigPath, JSON.stringify({
      agent: {
        build: {
          model: 'openai/gpt-5',
        },
      },
      default_agent: 'build',
      providers: {
        anthropic: {
          api_key: 'anthropic-key',
        },
      },
    }), 'utf8');

    const result = await prepareOpencodeLaunchArtifacts({
      runtimeEnv: {
        HOME: tmpRoot,
        OPENCODE_CONFIG: baseConfigPath,
      } as NodeJS.ProcessEnv,
      workspaceRoot: tmpRoot,
    });

    expect(result.configPath).toBe(path.join(tmpRoot, '.claudian', 'opencode', 'config.json'));
    const generatedConfig = JSON.parse(await fs.readFile(result.configPath, 'utf8'));
    // The original user document is loaded natively; the generated file owns only the overlay.
    const nativeConfig = JSON.parse(await fs.readFile(result.nativeConfigPath, 'utf8'));
    expect(nativeConfig).toMatchObject({
      agent: { build: { model: 'openai/gpt-5' } },
      default_agent: 'build',
      providers: {
        anthropic: {
          api_key: 'anthropic-key',
        },
      },
    });
    expect(generatedConfig.agent.build).toEqual({});
  });

  it('keeps the launch key stable when the resolved default database is later passed as OPENCODE_DB', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-artifacts-'));
    const baseParams = {
      workspaceRoot: tmpRoot,
    };
    const first = await prepareOpencodeLaunchArtifacts({
      ...baseParams,
      runtimeEnv: {
        HOME: tmpRoot,
      } as NodeJS.ProcessEnv,
    });

    const second = await prepareOpencodeLaunchArtifacts({
      ...baseParams,
      runtimeEnv: {
        HOME: tmpRoot,
        OPENCODE_DB: first.databasePath ?? undefined,
      } as NodeJS.ProcessEnv,
    });

    expect(first.databasePath).toBe(second.databasePath);
    expect(first.launchKey).toBe(second.launchKey);
  });

  it('delivers the caller-resolved instructions verbatim and keys the launch on them', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-artifacts-'));
    const baseParams = {
      runtimeEnv: { HOME: tmpRoot } as NodeJS.ProcessEnv,
      workspaceRoot: tmpRoot,
    };

    const first = await prepareOpencodeLaunchArtifacts({ ...baseParams, systemPromptText: 'Main Agent prompt A' });
    const second = await prepareOpencodeLaunchArtifacts({ ...baseParams, systemPromptText: 'Main Agent prompt B' });

    expect(JSON.parse(second.configContent).agent.build.prompt).toBe('Main Agent prompt B');
    expect(second.launchKey).not.toBe(first.launchKey);
  });

  it('creates the resolved OpenCode database directory before launch', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-artifacts-'));
    const xdgDataHome = path.join(tmpRoot, 'xdg-data');
    const databaseDir = path.join(xdgDataHome, 'opencode');

    const result = await prepareOpencodeLaunchArtifacts({
      runtimeEnv: {
        HOME: path.join(tmpRoot, 'home'),
        XDG_DATA_HOME: xdgDataHome,
      } as NodeJS.ProcessEnv,
      workspaceRoot: tmpRoot,
    });

    expect(result.databasePath).toBe(path.join(databaseDir, 'opencode.db'));
    await expect(fs.access(databaseDir)).resolves.toBeUndefined();
  });
});


it('layers v2 native agent policies after user rules and pins the native system prompt', () => {
  const config = buildOpencodeManagedConfig({ agents: {
    'claudian-inline-edit': { system: 'old', model: 'test/model', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
    plan: { disabled: false },
    reviewer: { description: 'Keep this' },
  } }, [{ id: 'claudian-inline-edit', prompt: 'Inline edit instructions', definition: {
    mode: 'primary', permission: { '*': 'deny', read: { '*': 'allow', '*.env': 'deny' }, bash: 'ask' },
  } }], 'claudian-inline-edit', 2);
  expect(config).toMatchObject({
    default_agent: 'claudian-inline-edit',
    agents: {
      'claudian-inline-edit': {
        system: 'Inline edit instructions', model: 'test/model', mode: 'primary',
        permissions: [
          { action: '*', resource: '*', effect: 'allow' },
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'read', resource: '*', effect: 'allow' },
          { action: 'read', resource: '*.env', effect: 'deny' },
          { action: 'shell', resource: '*', effect: 'ask' },
        ],
      },
      plan: { disabled: true },
      reviewer: { description: 'Keep this' },
    },
  });
});

it('preserves legacy user agent semantics under v2 native-over-legacy precedence', () => {
  const config = buildOpencodeManagedConfig({
    agent: { build: { model: 'test/user-model', permission: { read: 'deny' }, temperature: 0.2 } },
  }, undefined, undefined, 2);
  // v2 normalizes each map, then chooses the entire native entry for colliding IDs.
  const definitions = { ...(config.agent as Record<string, unknown>), ...(config.agents as Record<string, unknown>) };
  expect(definitions.build).toMatchObject({
    model: 'test/user-model', permission: { read: 'deny' }, temperature: 0.2,
  });
});

it('preserves custom JSONC and inline settings as separate native configuration layers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  const customPath = path.join(root, 'custom.jsonc');
  const custom = '{\n // User config\n "username": "file-user", "providers": {"example": {"settings": {"baseURL": "https://example.test/v1"}}},\n}\n';
  await fs.writeFile(customPath, custom);
  try {
    const result = await prepareOpencodeLaunchArtifacts({
      workspaceRoot: root, nativeVersion: 2, systemPromptText: 'Managed instructions',
      runtimeEnv: {
        OPENCODE_DB: ':memory:', OPENCODE_CONFIG: customPath,
        OPENCODE_CONFIG_CONTENT: '{ /* Inline override */ "username": "inline-user", "providers": {"example": {"settings": {"apiKey": "inline-test-key"}}}, }',
      },
    });
    expect(result.nativeConfigPath).toBe(customPath);
    expect(JSON.parse(result.configContent)).toMatchObject({
      username: 'inline-user', providers: { example: { settings: { apiKey: 'inline-test-key' } } },
    });
    expect(await fs.readFile(customPath, 'utf8')).toBe(custom);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.each(['missing-file', 'malformed-file', 'malformed-inline', 'non-object-inline'])('rejects %s configuration before launching with lost user settings', async source => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  const customPath = path.join(root, 'custom.jsonc');
  if (source === 'malformed-file') await fs.writeFile(customPath, '{"permissions":');
  try {
    await expect(prepareOpencodeLaunchArtifacts({
      workspaceRoot: root, nativeVersion: 2, systemPromptText: 'Managed instructions',
      runtimeEnv: {
        OPENCODE_DB: ':memory:',
        ...(source.endsWith('file') ? { OPENCODE_CONFIG: customPath } : {
          OPENCODE_CONFIG_CONTENT: source === 'non-object-inline' ? '[]' : '{"permissions":',
        }),
      },
    })).rejects.toThrow(/OpenCode.*config/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('keeps native custom-file loading at its original location for relative file references', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  const customPath = path.join(root, 'custom.jsonc');
  await fs.writeFile(path.join(root, 'key.txt'), 'local-test-key');
  await fs.writeFile(customPath, '{"providers":{"example":{"settings":{"apiKey":"{file:./key.txt}"}}}}');
  try {
    const result = await prepareOpencodeLaunchArtifacts({
      workspaceRoot: root, nativeVersion: 2, systemPromptText: 'Managed instructions',
      runtimeEnv: { OPENCODE_DB: ':memory:', OPENCODE_CONFIG: './custom.jsonc' },
    });
    // OpenCode resolves file variables relative to the native config document.
    const nativePath = result.nativeConfigPath;
    expect(await fs.readFile(path.resolve(path.dirname(nativePath), 'key.txt'), 'utf8')).toBe('local-test-key');
    expect(nativePath).toBe(customPath);
    expect(JSON.parse(result.configContent).agent.build.prompt).toBe('Managed instructions');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('accepts native raw environment expressions without copying expanded user config to disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  const customPath = path.join(root, 'custom.jsonc');
  const custom = '{"snapshots": {env:PROBE_SNAPSHOTS}, "providers":{"example":{"settings":{"apiKey":"{env:PROBE_KEY}"}}}}';
  await fs.writeFile(customPath, custom);
  try {
    const result = await prepareOpencodeLaunchArtifacts({
      workspaceRoot: root, nativeVersion: 2, systemPromptText: 'Managed instructions',
      runtimeEnv: {
        OPENCODE_DB: ':memory:', OPENCODE_CONFIG: customPath,
        PROBE_SNAPSHOTS: 'false', PROBE_KEY: 'environment-test-key',
        PROBE_LITERAL: '{env:PROBE_SECOND}', PROBE_SECOND: 'must-not-expand',
        OPENCODE_CONFIG_CONTENT: '{"snapshots": {env:PROBE_SNAPSHOTS}, "username": "{env:PROBE_LITERAL}"}',
      },
    });
    expect(JSON.parse(result.configContent)).toMatchObject({ snapshots: false, username: '{env:PROBE_SECOND}' });
    expect(result.configContent).not.toContain('{env:PROBE_SECOND}');
    expect(await fs.readFile(result.nativeConfigPath, 'utf8')).toBe(custom);
    expect(JSON.parse(await fs.readFile(result.configPath, 'utf8')).providers).toBeUndefined();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('resolves native file expressions from each source directory before parsing without recursive expansion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  const customDir = path.join(root, 'custom');
  await fs.mkdir(customDir);
  const customPath = path.join(customDir, 'config.jsonc');
  await fs.writeFile(customPath, '{"snapshots": {file:./flag.txt}}');
  await fs.writeFile(path.join(customDir, 'flag.txt'), 'false\n');
  await fs.writeFile(path.join(root, 'flag.txt'), 'true\n');
  await fs.writeFile(path.join(root, 'literal.txt'), '{file:./missing.txt} {env:PROBE_SECRET}\n');
  try {
    const result = await prepareOpencodeLaunchArtifacts({
      workspaceRoot: root, nativeVersion: 2, systemPromptText: 'Managed instructions',
      runtimeEnv: {
        OPENCODE_DB: ':memory:', OPENCODE_CONFIG: customPath, PROBE_SECRET: 'must-not-expand',
        PROBE_FILE: '{file:./literal.txt}',
        OPENCODE_CONFIG_CONTENT: '// {file:./ignored.txt}\n{"snapshots": {file:./flag.txt}, "username": "{env:PROBE_FILE}"}',
      },
    });
    expect(JSON.parse(result.configContent)).toMatchObject({
      snapshots: true, username: '{file:./missing.txt} {env:PROBE_SECRET}',
      agent: { build: { prompt: 'Managed instructions' } },
    });
    expect(result.configContent).not.toContain('{file:./missing.txt}');
    expect(result.configContent).not.toContain('{env:PROBE_SECRET}');
    expect(result.nativeConfigPath).toBe(customPath);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('uses the native process home for file references and keeps shell variable filenames literal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  const nativeHome = path.join(root, 'native-home');
  await fs.mkdir(nativeHome);
  await fs.writeFile(path.join(nativeHome, 'literal-$HOME.txt'), 'Native home value');
  try {
    const result = await prepareOpencodeLaunchArtifacts({
      workspaceRoot: root, nativeVersion: 2, systemPromptText: 'Managed instructions',
      runtimeEnv: {
        HOME: nativeHome, USERPROFILE: nativeHome, OPENCODE_DB: ':memory:',
        OPENCODE_CONFIG_CONTENT: '{"username": "{file:~/literal-$HOME.txt}"}',
      },
    });
    expect(JSON.parse(result.configContent).username).toBe('Native home value');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
