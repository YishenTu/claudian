import type { CodexLaunchSpec } from '@/providers/codex/runtime/codexLaunchTypes';
import { createCodexPathMapper } from '@/providers/codex/runtime/CodexPathMapper';
import { createCodexRuntimeContext } from '@/providers/codex/runtime/CodexRuntimeContext';

function createLaunchSpec(overrides: Partial<CodexLaunchSpec> = {}): CodexLaunchSpec {
  const target = {
    method: 'wsl' as const,
    platformFamily: 'unix' as const,
    platformOs: 'linux' as const,
    distroName: 'Ubuntu',
  };

  return {
    target,
    command: 'wsl.exe',
    args: ['--distribution', 'Ubuntu', '--cd', '/home/user/repo', 'codex', 'app-server', '--listen', 'stdio://'],
    spawnCwd: 'C:\\repo',
    targetCwd: '/home/user/repo',
    env: {},
    pathMapper: createCodexPathMapper(target),
    ...overrides,
  };
}

describe('createCodexRuntimeContext', () => {
  it('derives host-readable transcript roots from initialize.codexHome for WSL targets', () => {
    const context = createCodexRuntimeContext(
      createLaunchSpec(),
      {
        userAgent: 'test/0.1',
        codexHome: '/home/user/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    );

    expect(context.codexHomeHost).toBe('\\\\wsl$\\Ubuntu\\home\\user\\.codex');
    expect(context.sessionsDirTarget).toBe('/home/user/.codex/sessions');
    expect(context.sessionsDirHost).toBe('\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions');
    expect(context.memoriesDirTarget).toBe('/home/user/.codex/memories');
  });

  it('fails fast when initialize platform metadata does not match the selected target', () => {
    expect(() => createCodexRuntimeContext(
      createLaunchSpec(),
      {
        userAgent: 'test/0.1',
        codexHome: 'C:\\Users\\user\\.codex',
        platformFamily: 'windows',
        platformOs: 'windows',
      },
    )).toThrow('Codex target mismatch');
  });
});
