import { forwardWSLEnvironment } from '@/core/process/execution-target/WSLEnvironment';

it('forwards only declared existing keys with caller-selected path flags and preserves existing WSLENV semantics', () => {
  const env = { WSLENV: 'EXISTING/lu:ALREADY/p', EXISTING: 'one:two', ALREADY: 'C:\\keep', TOKEN: 'secret', ROOT: 'C:\\data', ROOTS: 'C:\\one;D:\\two', HOME: 'C:\\Users\\me', PATH: 'C:\\Windows' };
  const result = forwardWSLEnvironment(env, [{ key: 'TOKEN' }, { key: 'ROOT', hostPath: true }, { key: 'ROOTS', hostPath: true, pathList: true }, { key: 'ALREADY' }, { key: 'MISSING' }, { key: 'WSLENV' }]);
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

it.each<Record<string, string>>([
  { WSLENV: 'OTHER_HOME/p', HOME: 'C:\\home', OTHER_HOME: 'C:\\other' },
  { WSLENV: 'HOME/p' },
])('does not create a private HOME copy unless HOME itself is present and forwarded (%j)', env => {
  expect(forwardWSLEnvironment(env, [])).toEqual(env);
});

it('retains native environment values without inventing a forwarding list', () => {
  expect(forwardWSLEnvironment({ TOKEN: 'native-token' }, [])).toEqual({ TOKEN: 'native-token' });
});

it('clears an inherited forwarding entry when the caller declares an absent value', () => {
  expect(forwardWSLEnvironment({ WSLENV: 'REMOVED/p', TOKEN: 'native-token' }, [{ key: 'REMOVED' }]))
    .toEqual({ WSLENV: '', TOKEN: 'native-token' });
});
