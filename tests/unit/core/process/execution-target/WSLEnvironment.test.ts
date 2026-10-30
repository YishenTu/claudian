import { forwardWSLEnvironment } from '@/core/process/execution-target/WSLEnvironment';

it('forwards only declared existing keys with caller-selected path flags and preserves existing WSLENV semantics', () => {
  const env = { WSLENV: 'EXISTING/lu:ALREADY/p', EXISTING: 'one:two', ALREADY: 'C:\\keep', TOKEN: 'secret', ROOT: 'C:\\data', ROOTS: 'C:\\one;D:\\two', HOME: 'C:\\Users\\me', PATH: 'C:\\Windows' };
  const result = forwardWSLEnvironment(env, [{ key: 'TOKEN' }, { key: 'ROOT', hostPath: true }, { key: 'ROOTS', hostPath: true, pathList: true }, { key: 'ALREADY' }, { key: 'MISSING' }]);
  expect(result.WSLENV).toBe('EXISTING/lu:TOKEN:ROOT/p:ROOTS/pl:ALREADY');
  expect(result.TOKEN).toBe('secret');
  expect(env.WSLENV).toBe('EXISTING/lu:ALREADY/p');
});

it('replaces inherited direction and translation flags for caller-forwarded keys', () => {
  expect(forwardWSLEnvironment({ WSLENV: 'KEEP/lu:OPENAI_API_KEY/w:ROOT/up:ROOT/w', OPENAI_API_KEY: 'configured', ROOT: 'C:\\root' }, [
    { key: 'OPENAI_API_KEY' }, { key: 'ROOT', hostPath: true, pathList: true },
  ]).WSLENV).toBe('KEEP/lu:OPENAI_API_KEY:ROOT/pl');
});

it('preserves forwarded HOME path flags on the copy protected from WSL account defaults', () => {
  expect(forwardWSLEnvironment({ HOME: 'C:\\home', WSLENV: 'HOME/up' }, []))
    .toEqual({ HOME: 'C:\\home', CLAUDIAN_WSL_HOME: 'C:\\home', WSLENV: 'HOME/up:CLAUDIAN_WSL_HOME/up' });
  expect(forwardWSLEnvironment({ HOME: 'C:\\home', WSLENV: 'HOME/w' }, []))
    .toEqual({ HOME: 'C:\\home', WSLENV: 'HOME/w' });
});
