import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildOpencodeManagedConfig,
  prepareOpencodeLaunchArtifacts,
  writeIfChanged,
} from '@/providers/opencode/runtime/OpencodeLaunchArtifacts';

describe('buildOpencodeManagedConfig', () => {
  it('keeps user build approval rules under native configuration', () => {
    const config = buildOpencodeManagedConfig({
      agent: { build: { permission: { bash: 'ask', read: { '*.env': 'ask' } }, model: 'test/model' } },
      ...({ agents: { build: {
        model: 'test/model', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
      } } }),
    }, [{ id: 'build', prompt: 'Main instructions' }]);
    expect(config).toMatchObject({
      agent: { build: {
        model: 'test/model', permission: { bash: 'ask', read: { '*.env': 'ask' } }, prompt: 'Main instructions',
      } },
      ...({ agents: { build: {
        model: 'test/model', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }], system: 'Main instructions',
      } } }),
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
        workspaceRoot: root, runtimeEnv: { HOME: root, OPENCODE_DB: ':memory:', OPENCODE_CONFIG_CONTENT: '{"plugins":["user-plugin"]}' },
        sessionToolsPluginPath: path.join(root, 'plugin.js'),
      });
      expect(result.configContent).not.toMatch(/"(prompt|system)"/);
      expect(result.configContent).not.toContain('Stale instructions');
      expect(JSON.parse(result.configContent).plugins).toEqual([
        'user-plugin', { package: pathToFileURL(path.join(root, 'plugin.js')).href },
      ]);
      await expect(fs.access(legacyPrompts)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the same database when the resolved default database is later passed as OPENCODE_DB', async () => {
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

  // Windows rejects a rename onto a target another launch is replacing with EPERM.
  it.each([
    ['accepts the shared file a concurrent launch already wrote', true],
    ['rejects a failed replacement that left the shared file stale', false],
  ])('%s', async (_name, peerWrites) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-rename-'));
    const file = path.join(root, 'config.json');
    const content = '{"agents":{}}\n';
    await fs.writeFile(file, '{}\n');
    const rename = jest.spyOn(fs, 'rename').mockImplementationOnce(async () => {
      if (peerWrites) await fs.writeFile(file, content);
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    });
    try {
      const outcome = await writeIfChanged(file, content).then(result => result, (error: unknown) => error);
      const rejected = expect.objectContaining({ code: 'EPERM' });
      expect(outcome).toEqual(peerWrites ? undefined : rejected);
      await expect(fs.readFile(file, 'utf8')).resolves.toBe(peerWrites ? content : '{}\n');
      await expect(fs.readdir(path.dirname(file))).resolves.toEqual(['config.json']);
    } finally {
      rename.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});


it('layers v2 native agent policies after user rules and pins the native system prompt', () => {
  const config = buildOpencodeManagedConfig({ agents: {
    'claudian-inline-edit': { system: 'old', model: 'test/model', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
    plan: { disabled: false },
    reviewer: { description: 'Keep this' },
  } }, [{ id: 'claudian-inline-edit', prompt: 'Inline edit instructions', definition: {
    mode: 'primary', permission: { '*': 'deny', read: { '*': 'allow', '*.env': 'deny' }, bash: 'ask' },
  } }], 'claudian-inline-edit');
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
  }, undefined, undefined);
  // v2 normalizes each map, then chooses the entire native entry for colliding IDs.
  const definitions = { ...(config.agent as Record<string, unknown>), ...(config.agents as Record<string, unknown>) };
  expect(definitions.build).toMatchObject({
    model: 'test/user-model', permission: { read: 'deny' }, temperature: 0.2,
  });
});

it('parses inline JSONC settings into the managed native layer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  try {
    const result = await prepareOpencodeLaunchArtifacts({
      workspaceRoot: root,
      runtimeEnv: {
        OPENCODE_DB: ':memory:',
        OPENCODE_CONFIG_CONTENT: '{ /* Inline override */ "username": "inline-user", "providers": {"example": {"settings": {"apiKey": "inline-test-key"}}}, }',
      },
    });
    expect(JSON.parse(result.configContent)).toMatchObject({
      username: 'inline-user', providers: { example: { settings: { apiKey: 'inline-test-key' } } },
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.each(['malformed-inline', 'non-object-inline'])('rejects %s configuration before launching with lost user settings', async source => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  try {
    await expect(prepareOpencodeLaunchArtifacts({
      workspaceRoot: root,
      runtimeEnv: {
        OPENCODE_DB: ':memory:',
        OPENCODE_CONFIG_CONTENT: source === 'non-object-inline' ? '[]' : '{"permissions":',
      },
    })).rejects.toThrow(/OpenCode.*config/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('accepts native raw environment expressions without copying expanded user config into the vault', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  try {
    const result = await prepareOpencodeLaunchArtifacts({
      workspaceRoot: root,
      runtimeEnv: {
        OPENCODE_DB: ':memory:',
        PROBE_SNAPSHOTS: 'false',
        PROBE_LITERAL: '{env:PROBE_SECOND}', PROBE_SECOND: 'must-not-expand',
        OPENCODE_CONFIG_CONTENT: '{"snapshots": {env:PROBE_SNAPSHOTS}, "username": "{env:PROBE_LITERAL}"}',
      },
    });
    expect(JSON.parse(result.configContent)).toMatchObject({ snapshots: false, username: '{env:PROBE_SECOND}' });
    expect(result.configContent).not.toContain('{env:PROBE_SECOND}');
    await expect(fs.access(path.join(root, '.claudian', 'opencode'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('resolves inline file expressions from the workspace before parsing without recursive expansion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  await fs.writeFile(path.join(root, 'flag.txt'), 'true\n');
  await fs.writeFile(path.join(root, 'literal.txt'), '{file:./missing.txt} {env:PROBE_SECRET}\n');
  try {
    const result = await prepareOpencodeLaunchArtifacts({
      workspaceRoot: root,
      runtimeEnv: {
        OPENCODE_DB: ':memory:', PROBE_SECRET: 'must-not-expand',
        PROBE_FILE: '{file:./literal.txt}',
        OPENCODE_CONFIG_CONTENT: '// {file:./ignored.txt}\n{"snapshots": {file:./flag.txt}, "username": "{env:PROBE_FILE}"}',
      },
    });
    expect(JSON.parse(result.configContent)).toMatchObject({
      snapshots: true, username: '{file:./missing.txt} {env:PROBE_SECRET}',
      agent: { build: {} },
    });
    expect(result.configContent).not.toContain('{file:./missing.txt}');
    expect(result.configContent).not.toContain('{env:PROBE_SECRET}');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('uses the native process home for file references and keeps shell variable filenames literal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-config-'));
  const nativeHome = path.join(root, 'native-home');
  await fs.mkdir(nativeHome);
  await fs.writeFile(path.join(nativeHome, 'literal-$HOME.txt'), 'Native home value');
  try {
    const result = await prepareOpencodeLaunchArtifacts({
      workspaceRoot: root,
      runtimeEnv: {
        HOME: nativeHome, USERPROFILE: nativeHome, OPENCODE_DB: ':memory:',
        OPENCODE_CONFIG_CONTENT: '{"username": "{file:~/literal-$HOME.txt}"}',
      },
    });
    expect(JSON.parse(result.configContent).username).toBe('Native home value');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
