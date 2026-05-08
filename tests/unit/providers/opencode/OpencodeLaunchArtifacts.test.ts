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
  it('pins OpenCode build, YOLO, safe, and plan prompts to the managed prompt file', () => {
    expect(buildOpencodeManagedConfig({}, '/vault/.claudian/opencode/system.md', 'Yishen')).toEqual({
      $schema: 'https://opencode.ai/config.json',
      agent: {
        build: {
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
        [OPENCODE_YOLO_MODE_ID]: {
          mode: 'primary',
          permission: {
            plan_enter: 'allow',
            question: 'allow',
          },
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
        [OPENCODE_SAFE_MODE_ID]: {
          mode: 'primary',
          permission: {
            bash: 'ask',
            edit: 'ask',
            plan_enter: 'allow',
            question: 'allow',
          },
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
        plan: {
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
            plan_enter: 'allow',
            question: 'allow',
          },
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
        [OPENCODE_SAFE_MODE_ID]: {
          mode: 'primary',
          permission: {
            bash: 'ask',
            edit: 'ask',
            plan_enter: 'allow',
            question: 'allow',
          },
          prompt: '{file:/vault/.claudian/opencode/system.md}',
        },
        plan: {
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
    expect(result.configContent).toContain(`"prompt": "{file:${result.systemPromptPath}}"`);
    const generatedConfig = JSON.parse(await fs.readFile(result.configPath, 'utf8'));
    expect(generatedConfig).toMatchObject({
      default_agent: 'build',
      providers: {
        anthropic: {
          api_key: 'anthropic-key',
        },
      },
      username: 'Yishen',
    });
    expect(generatedConfig.agent).toMatchObject({
      build: {
        model: 'openai/gpt-5',
        prompt: `{file:${result.systemPromptPath}}`,
      },
      [OPENCODE_YOLO_MODE_ID]: {
        mode: 'primary',
        permission: {
          plan_enter: 'allow',
          question: 'allow',
        },
        prompt: `{file:${result.systemPromptPath}}`,
      },
      [OPENCODE_SAFE_MODE_ID]: {
        mode: 'primary',
        permission: {
          bash: 'ask',
          edit: 'ask',
          plan_enter: 'allow',
          question: 'allow',
        },
        prompt: `{file:${result.systemPromptPath}}`,
      },
      plan: {
        prompt: `{file:${result.systemPromptPath}}`,
      },
    });
  });
});
