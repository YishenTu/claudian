import { buildOpencodeManagedConfig } from '../../../../src/providers/opencode/runtime/OpencodeLaunchArtifacts';

describe('buildOpencodeManagedConfig', () => {
  it('pins OpenCode to the managed build agent prompt file', () => {
    expect(buildOpencodeManagedConfig('/vault/.context/opencode/system.md', 'Yishen')).toEqual({
      $schema: 'https://opencode.ai/config.json',
      agent: {
        build: {
          prompt: '{file:/vault/.context/opencode/system.md}',
        },
      },
      default_agent: 'build',
      username: 'Yishen',
    });
  });
});
