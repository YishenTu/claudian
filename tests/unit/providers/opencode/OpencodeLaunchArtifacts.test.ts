import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  OPENCODE_SAFE_MODE_ID,
  OPENCODE_YOLO_MODE_ID,
} from '../../../../src/providers/opencode/modes';
import {
  buildOpencodeManagedConfig,
  prepareOpencodeLaunchArtifacts,
} from '../../../../src/providers/opencode/runtime/OpencodeLaunchArtifacts';

describe('buildOpencodeManagedConfig', () => {
  it('pins OpenCode build, YOLO, and safe prompts to the managed prompt file', () => {
    expect(buildOpencodeManagedConfig({}, '/vault/.claudian/opencode/system.md', 'Yishen')).toEqual({
      $schema: 'https://opencode.ai/config.json',
      agent: {
        plan: { disable: true },
        build: {
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
        [OPENCODE_YOLO_MODE_ID]: {
          mode: 'primary',
          permission: {
            plan_enter: 'deny',
            question: 'allow',
          },
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
        [OPENCODE_SAFE_MODE_ID]: {
          mode: 'primary',
          permission: {
            bash: 'ask',
            edit: 'ask',
            plan_enter: 'deny',
            question: 'allow',
          },
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
      },
      username: 'Yishen',
    });
  });

  it('can create a dedicated aux agent and default it for the process', () => {
    expect(buildOpencodeManagedConfig(
      {},
      '/vault/.claudian/opencode/auxiliary/system.md',
      undefined,
      [{
        definition: {
          mode: 'primary',
          permission: {
            '*': 'deny',
            read: 'allow',
          },
        },
        id: 'claudian-aux-readonly',
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
          prompt: '{file:/vault/.claudian/opencode/auxiliary/system.md}',
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
      '/vault/.claudian/opencode/system.md',
      undefined,
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
    }, '/vault/.claudian/opencode/system.md')).toEqual({
      $schema: 'https://opencode.ai/config.json',
      agent: {
        plan: { disable: true },
        build: {
          model: 'openai/gpt-5',
          permission: {
            bash: 'ask',
            edit: 'ask',
          },
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
        [OPENCODE_YOLO_MODE_ID]: {
          mode: 'primary',
          permission: {
            plan_enter: 'deny',
            question: 'allow',
          },
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
        [OPENCODE_SAFE_MODE_ID]: {
          mode: 'primary',
          permission: {
            bash: 'ask',
            edit: 'ask',
            plan_enter: 'deny',
            question: 'allow',
          },
          prompt: '{file:/vault/.claudian/opencode/system.md}',
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
      settings: {
        customPrompt: '',
        mediaFolder: '',
        userName: 'Yishen',
        vaultPath: tmpRoot,
      },
      workspaceRoot: tmpRoot,
    });

    expect(result.configPath).toBe(path.join(tmpRoot, '.claudian', 'opencode', 'config.json'));
    expect(result.systemPromptPath).toBe(path.join(tmpRoot, '.claudian', 'opencode', 'system.md'));
    expect(result.configContent).toContain(`"prompt": ${JSON.stringify(`{file:${result.systemPromptPath}}`)}`);
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
    expect(generatedConfig.username).toBe('Yishen');
    expect(generatedConfig.agent).toMatchObject({
      build: {
        prompt: `{file:${result.systemPromptPath}}`,
      },
      [OPENCODE_YOLO_MODE_ID]: {
        mode: 'primary',
        permission: {
          plan_enter: 'deny',
          question: 'allow',
        },
        prompt: `{file:${result.systemPromptPath}}`,
      },
      [OPENCODE_SAFE_MODE_ID]: {
        mode: 'primary',
        permission: {
          bash: 'ask',
          edit: 'ask',
          plan_enter: 'deny',
          question: 'allow',
        },
        prompt: `{file:${result.systemPromptPath}}`,
      },
    });
  });

  it('keeps the launch key stable when the resolved default database is later passed as OPENCODE_DB', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-artifacts-'));
    const baseParams = {
      settings: {
        customPrompt: '',
        mediaFolder: '',
        userName: '',
        vaultPath: tmpRoot,
      },
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

  it('includes provider-default dynamic sections in the managed prompt and launch key', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-artifacts-'));
    const baseParams = {
      runtimeEnv: { HOME: tmpRoot } as NodeJS.ProcessEnv,
      settings: {
        customPrompt: '',
        mediaFolder: '',
        userName: '',
        vaultPath: tmpRoot,
      },
      workspaceRoot: tmpRoot,
    };

    const withoutAppendix = await prepareOpencodeLaunchArtifacts(baseParams);
    const withAppendix = await prepareOpencodeLaunchArtifacts({
      ...baseParams,
      dynamicSystemPromptSections: ['## Collab Mode\nRuntime guidance.'],
    });
    const prompt = await fs.readFile(withAppendix.systemPromptPath, 'utf8');

    expect(prompt).toContain('## Runtime Context');
    expect(prompt).toContain('## Collab Mode\nRuntime guidance.');
    expect(prompt.match(/## Collab Mode/g)).toHaveLength(1);
    expect(withAppendix.launchKey).not.toBe(withoutAppendix.launchKey);
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
      settings: {
        customPrompt: '',
        mediaFolder: '',
        userName: '',
        vaultPath: tmpRoot,
      },
      workspaceRoot: tmpRoot,
    });

    expect(result.databasePath).toBe(path.join(databaseDir, 'opencode.db'));
    await expect(fs.access(databaseDir)).resolves.toBeUndefined();
  });
});


it('layers v2 native agent policies after user rules and pins the native system prompt', () => {
  const config = buildOpencodeManagedConfig({ agents: {
    'claudian-safe': { system: 'old', model: 'test/model', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
    plan: { disabled: false },
    reviewer: { description: 'Keep this' },
  } }, '/vault/system.md', undefined, [{ id: 'claudian-safe', definition: {
    mode: 'primary', permission: { '*': 'deny', read: { '*': 'allow', '*.env': 'deny' }, bash: 'ask' },
  } }], 'claudian-safe', 2);
  expect(config).toMatchObject({
    default_agent: 'claudian-safe',
    agents: {
      'claudian-safe': {
        system: '{file:/vault/system.md}', model: 'test/model', mode: 'primary',
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
  }, '/vault/system.md', undefined, undefined, undefined, 2);
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
    expect(JSON.parse(result.configContent).agent.build.prompt).toBe(`{file:${result.systemPromptPath}}`);
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
      agent: { build: { prompt: `{file:${result.systemPromptPath}}` } },
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
