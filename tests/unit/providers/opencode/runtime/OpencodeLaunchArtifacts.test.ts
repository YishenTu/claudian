import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildOpencodeManagedConfig,
  prepareOpencodeLaunchArtifacts,
} from '@/providers/opencode/runtime/OpencodeLaunchArtifacts';

describe('buildOpencodeManagedConfig', () => {
  it('keeps user build approval rules under native configuration', () => {
    const config = buildOpencodeManagedConfig({
      agent: { build: { permission: { bash: 'ask', read: { '*.env': 'ask' } }, model: 'test/model' } },
      agents: { build: {
        model: 'test/model', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
      } },
    }, '/vault/main.md');
    expect(config).toMatchObject({
      agent: { build: {
        model: 'test/model', permission: { bash: 'ask', read: { '*.env': 'ask' } }, prompt: '{file:/vault/main.md}',
      } },
      agents: { build: {
        model: 'test/model', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }], system: '{file:/vault/main.md}',
      } },
    });
  });

  it('pins the OpenCode build prompt to the managed prompt file', () => {
    expect(buildOpencodeManagedConfig({}, '/vault/.claudian/opencode/system.md')).toEqual({
      $schema: 'https://opencode.ai/config.json',
      agent: {
        plan: { disable: true },
        build: {
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
      },
    });
  });

  it('can create a dedicated aux agent and default it for the process', () => {
    expect(buildOpencodeManagedConfig(
      {},
      '/vault/.claudian/opencode/auxiliary/system.md',
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
  it('creates missing default prompts without replacing existing ones', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-prompts-'));
    const base = { workspaceRoot: root, runtimeEnv: { HOME: root } };
    const prompts = path.join(root, '.claudian', 'opencode', 'prompts');
    try {
      await fs.mkdir(prompts, { recursive: true });
      await fs.writeFile(path.join(prompts, 'main.md'), 'Main instructions\n');
      await prepareOpencodeLaunchArtifacts(base);
      expect(await fs.readFile(path.join(prompts, 'main.md'), 'utf8')).toBe('Main instructions\n');

      await fs.rm(prompts, { recursive: true });
      await prepareOpencodeLaunchArtifacts(base);
      expect(await fs.readFile(path.join(prompts, 'main.md'), 'utf8')).toContain('## Runtime Context');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])('creates distinct referenced prompts for concurrent launches with hard-link support: %s', async (supportsLinks) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-prompts-'));
    const base = { workspaceRoot: root, runtimeEnv: { HOME: root } };
    const link = supportsLinks ? undefined : jest.spyOn(fs, 'link').mockRejectedValue(
      Object.assign(new Error('Hard links are unsupported'), { code: 'ENOTSUP' }),
    );
    try {
      const [first, second] = await Promise.all([
        prepareOpencodeLaunchArtifacts(base),
        prepareOpencodeLaunchArtifacts(base),
      ]);
      expect(second.configContent).toBe(first.configContent);
      const prompts = path.join(root, '.claudian', 'opencode', 'prompts');
      const texts = await Promise.all(['main.md', 'inline-edit.md', 'title.md']
        .map(name => fs.readFile(path.join(prompts, name), 'utf8')));
      expect(texts.every(text => text.trim().length > 0)).toBe(true);
      expect(new Set(texts).size).toBe(3);
      expect(JSON.parse(first.configContent)).toMatchObject({
        default_agent: 'build',
        agent: {
          build: { prompt: `{file:${path.join(prompts, 'main.md')}}` },
          'claudian-inline-edit': { prompt: `{file:${path.join(prompts, 'inline-edit.md')}}` },
          'claudian-title': { prompt: `{file:${path.join(prompts, 'title.md')}}` },
        },
      });
    } finally {
      link?.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('appends the session tools plugin after inline plugins', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-artifacts-'));
    const pluginPath = path.join(root, 'session-tools');
    try {
      const result = await prepareOpencodeLaunchArtifacts({
        workspaceRoot: root, sessionToolsPluginPath: pluginPath,
        runtimeEnv: { HOME: root, OPENCODE_DB: ':memory:', OPENCODE_CONFIG_CONTENT: '{"plugins": ["user-plugin"]}' },
      });
      expect(JSON.parse(result.configContent).plugins).toEqual(['user-plugin', { package: pathToFileURL(pluginPath).href }]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('resolves the same database when the default database is later passed as OPENCODE_DB', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-artifacts-'));
    try {
      const first = await prepareOpencodeLaunchArtifacts({ workspaceRoot: tmpRoot, runtimeEnv: { HOME: tmpRoot } });
      const second = await prepareOpencodeLaunchArtifacts({
        workspaceRoot: tmpRoot,
        runtimeEnv: { HOME: tmpRoot, OPENCODE_DB: first.databasePath ?? undefined },
      });
      expect(first.databasePath).toBe(second.databasePath);
    } finally { await fs.rm(tmpRoot, { recursive: true, force: true }); }
  });

  it('creates the resolved OpenCode database directory before launch', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-artifacts-'));
    const xdgDataHome = path.join(tmpRoot, 'xdg-data');
    const databaseDir = path.join(xdgDataHome, 'opencode');
    try {
      const result = await prepareOpencodeLaunchArtifacts({
        runtimeEnv: {
          HOME: path.join(tmpRoot, 'home'),
          XDG_DATA_HOME: xdgDataHome,
        } as NodeJS.ProcessEnv,
        workspaceRoot: tmpRoot,
      });

      expect(result.databasePath).toBe(path.join(databaseDir, 'opencode.db'));
      await expect(fs.access(databaseDir)).resolves.toBeUndefined();
    } finally { await fs.rm(tmpRoot, { recursive: true, force: true }); }
  });
});


it('layers native agent policies after user rules and pins the native system prompt', () => {
  const config = buildOpencodeManagedConfig({ agents: {
    'claudian-inline-edit': { system: 'old', model: 'test/model', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
    plan: { disabled: false },
    reviewer: { description: 'Keep this' },
  } }, '/vault/system.md', [{ id: 'claudian-inline-edit', definition: {
    mode: 'primary', permission: { '*': 'deny', read: { '*': 'allow', '*.env': 'deny' }, bash: 'ask' },
  } }], 'claudian-inline-edit');
  expect(config).toMatchObject({
    default_agent: 'claudian-inline-edit',
    agents: {
      'claudian-inline-edit': {
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

it('preserves legacy user agent semantics under native-over-legacy precedence', () => {
  const config = buildOpencodeManagedConfig({
    agent: { build: { model: 'test/user-model', permission: { read: 'deny' }, temperature: 0.2 } },
  }, '/vault/system.md');
  // OpenCode normalizes each map, then chooses the entire native entry for colliding IDs.
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
    // Only prompt files are written to the (possibly synced) vault.
    expect(await fs.readdir(path.join(root, '.claudian', 'opencode'))).toEqual(['prompts']);
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
      agent: { build: { prompt: `{file:${path.join(root, '.claudian', 'opencode', 'prompts', 'main.md')}}` } },
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
