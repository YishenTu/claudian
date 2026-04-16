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

function createHostLaunchSpec(overrides: Partial<CodexLaunchSpec> = {}): CodexLaunchSpec {
  const target = {
    method: 'host-native' as const,
    platformFamily: 'unix' as const,
    platformOs: 'macos' as const,
  };

  return {
    target,
    command: 'codex',
    args: ['app-server', '--listen', 'stdio://'],
    spawnCwd: '/Users/test/repo',
    targetCwd: '/Users/test/repo',
    env: { HOME: '/Users/test' },
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

  it('falls back to HOME when initialize omits codexHome for host-native targets', () => {
    const context = createCodexRuntimeContext(
      createHostLaunchSpec(),
      {
        userAgent: 'test/0.1',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    );

    expect(context.codexHomeTarget).toBe('/Users/test/.codex');
    expect(context.codexHomeHost).toBe('/Users/test/.codex');
    expect(context.sessionsDirTarget).toBe('/Users/test/.codex/sessions');
    expect(context.sessionsDirHost).toBe('/Users/test/.codex/sessions');
    expect(context.memoriesDirTarget).toBe('/Users/test/.codex/memories');
  });

  it('keeps transcript roots nullable when initialize omits codexHome for WSL targets', () => {
    const context = createCodexRuntimeContext(
      createLaunchSpec(),
      {
        userAgent: 'test/0.1',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    );

    expect(context.codexHomeTarget).toBeNull();
    expect(context.codexHomeHost).toBeNull();
    expect(context.sessionsDirTarget).toBeNull();
    expect(context.sessionsDirHost).toBeNull();
    expect(context.memoriesDirTarget).toBeNull();
  });
});
