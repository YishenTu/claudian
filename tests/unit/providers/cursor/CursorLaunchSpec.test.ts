import { buildCursorLaunchSpec } from '@/providers/cursor/runtime/CursorLaunchSpec';

describe('buildCursorLaunchSpec', () => {
  it('starts Cursor Agent in ACP mode in the conversation workspace', () => {
    expect(buildCursorLaunchSpec({
      command: '/Users/test/.local/bin/agent',
      cwd: '/vault/project',
      env: { CURSOR_API_KEY: 'secret', PATH: '/usr/bin:/bin' },
    })).toEqual({
      args: ['acp'],
      command: '/Users/test/.local/bin/agent',
      cwd: '/vault/project',
      env: {
        CURSOR_API_KEY: 'secret',
        PATH: '/Users/test/.local/bin:/usr/bin:/bin',
      },
    });
  });
});
