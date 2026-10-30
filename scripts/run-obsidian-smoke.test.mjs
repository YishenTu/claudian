import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import test from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';

import { assertBuildTarget, parseArguments } from './run-obsidian-smoke.mjs';

const script = fileURLToPath(new URL('./run-obsidian-smoke.mjs', import.meta.url));

test('smoke build accepts only its fresh temporary vault and an env-free staged checkout', () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'claudian-obsidian-smoke-'));
  const outside = mkdtempSync(path.join(realpathSync(tmpdir()), 'other-vault-'));
  try {
    const vault = path.join(root, 'vault');
    const checkout = path.join(root, 'checkout');
    mkdirSync(vault); mkdirSync(checkout);
    const options = { tempRoot: root, vault, checkout, env: { OBSIDIAN_VAULT: vault } };
    assert.doesNotThrow(() => assertBuildTarget(options));
    assert.throws(() => assertBuildTarget({ ...options, vault: outside, env: { OBSIDIAN_VAULT: outside } }), /temporary vault/);
    assert.throws(() => assertBuildTarget({ ...options, env: { OBSIDIAN_VAULT: outside } }), /OBSIDIAN_VAULT/);
    assert.throws(() => assertBuildTarget({ ...options, env: {} }), /OBSIDIAN_VAULT/);
    symlinkSync(outside, path.join(root, 'escaped-vault'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertBuildTarget({ ...options, vault: path.join(root, 'escaped-vault') }), /temporary vault/);
    writeFileSync(path.join(checkout, '.env.local'), `OBSIDIAN_VAULT=${outside}\n`);
    assert.throws(() => assertBuildTarget(options), /\.env\.local/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('argument errors and help finish without launching Obsidian', () => {
  assert.equal(parseArguments(['--help']).help, true);
  assert.equal(parseArguments(['--app', '/Applications/Test.app']).app, '/Applications/Test.app');
  for (const args of [['--vault', '/real-vault'], ['--profile', '/profile'], ['--app'], ['--timeout-ms', 'zero'], ['--timeout-ms', '0'], ['--unknown']]) {
    assert.throws(() => parseArguments(args), /argument|value|timeout/i);
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /argument|value|timeout/i);
    assert.doesNotMatch(result.stdout, /Artifacts:/);
  }
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /macOS/);
  assert.match(help.stdout, /Linux.*not supported/);
  const dry = spawnSync(process.execPath, [script, '--dry-run'], { encoding: 'utf8', env: { ...process.env, CI: 'true' } });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /no directories, build or app process/);
  assert.match(dry.stdout, /Sandbox profile:/);
  assert.match(dry.stdout, /deny network-outbound/);
  assert.match(dry.stdout, /OBSIDIAN_VAULT/);
  assert.doesNotMatch(dry.stdout, /Artifacts:/);
});

test('bootstrap keeps manifests out of the scan until origin trust can be seeded', async () => {
  const { stagePluginBootstrap } = await import('./obsidian-smoke/bootstrap.mjs');
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'claudian-obsidian-smoke-'));
  try {
    const vault = path.join(root, 'vault');
    const plugins = path.join(vault, '.obsidian/plugins');
    mkdirSync(path.join(plugins, 'claudian'), { recursive: true });
    writeFileSync(path.join(plugins, 'claudian/manifest.json'), '{"id":"realclaudian"}');
    const staged = stagePluginBootstrap(vault, root);
    assert.equal(existsSync(plugins), false, 'Host must see no manifests before its localStorage key is set');
    assert.equal(existsSync(path.join(staged, 'claudian/manifest.json')), true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(vault, '.obsidian/community-plugins.json'), 'utf8')), ['realclaudian', 'claudian-smoke-probe']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Windows does not deliver POSIX signals to Node handlers; the runner supports macOS only.
for (const [signal, repeated] of [['SIGINT', false], ['SIGINT', true], ['SIGTERM', true]]) {
  test(`smoke cleanup survives ${repeated ? 'repeated' : 'one'} ${signal}`, { skip: process.platform === 'win32' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudian-smoke-signal-test-'));
    const app = path.join(root, 'Fake.app');
    const observations = path.join(root, 'observations.jsonl');
    const childFile = path.join(root, 'signal-child.mjs');
    mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
    writeFileSync(path.join(app, 'Contents/MacOS/Obsidian'), 'never executed');
    writeFileSync(observations, '');
    writeFileSync(childFile, `
      import fs from 'node:fs';
      import childProcess from 'node:child_process';
      import { EventEmitter } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      import timers from 'node:timers/promises';
      import { runSmoke } from ${JSON.stringify(pathToFileURL(script).href)};
      const record = value => fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify(value) + '\\n');
      const realMkdtemp = fs.mkdtempSync;
      fs.mkdtempSync = (...args) => { const root = realMkdtemp(...args); record({ root }); return root; };
      // Exercise the real runner's shutdown without copying, building, or launching an app.
      fs.cpSync = () => {};
      const realExists = fs.existsSync;
      fs.existsSync = file => file === '/usr/bin/sandbox-exec' || realExists(file);
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      childProcess.spawn = () => {
        const child = new EventEmitter();
        child.pid = 123456789;
        process.send('ready');
        return child;
      };
      process.kill = (pid, signal) => {
        if (pid !== -123456789) throw new Error('Unexpected process group');
        record({ signal });
        return true;
      };
      process.on('message', () => {}); // Keep IPC alive while the grace-period promise is held.
      const realDelay = timers.setTimeout;
      timers.setTimeout = (ms, ...args) => {
        if (ms === 800 && ${repeated}) {
          process.send('terminating');
          return new Promise(() => {}); // Only the repeated signal can end this held grace period.
        }
        return realDelay(ms, ...args);
      };
      console.log = message => { if (message.startsWith('Artifacts: ')) record({ artifacts: message.slice(11) }); };
      syncBuiltinESMExports();
      process.exitCode = await runSmoke({ app: process.argv[2], timeout: 5000 });
      process.disconnect();
    `);
    const child = fork(childFile, [app], { silent: true, env: { ...process.env, CI: 'false' } });
    child.on('message', message => {
      if (message === 'ready' || (repeated && message === 'terminating')) child.kill(signal);
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    let recorded = [];
    try {
      const [code, exitSignal] = await once(child, 'close');
      recorded = readFileSync(observations, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const owned = recorded.find(item => item.root)?.root;
      assert.ok(owned, `runner created its owned temporary root: ${stderr}`);
      assert.equal(existsSync(owned), false, 'owned temporary root must be removed');
      assert.ok(recorded.some(item => item.signal === 'SIGKILL'), 'owned process group receives final SIGKILL');
      assert.equal(exitSignal, null, 'runner handles signals through cleanup');
      assert.equal(code, signal === 'SIGINT' ? 130 : 143);
    } finally {
      clearTimeout(deadline);
      child.kill('SIGKILL');
      for (const item of recorded) {
        if (item.root) rmSync(item.root, { recursive: true, force: true });
        if (item.artifacts) rmSync(item.artifacts, { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('smoke sandbox protects the OS account home when HOME is overridden', { skip: process.platform === 'win32' }, () => {
  const alternateHome = mkdtempSync(path.join(realpathSync(tmpdir()), 'claudian-smoke-home-'));
  try {
    const result = spawnSync(process.execPath, [script, '--dry-run'], {
      encoding: 'utf8', env: { ...process.env, HOME: alternateHome },
    });
    assert.equal(result.status, 0, result.stderr);
    const policy = result.stdout.split('Sandbox profile:\n')[1];
    assert.ok(result.stdout.includes(JSON.stringify(path.join(realpathSync(userInfo().homedir), '.obsidian-cli.sock'))), 'socket post-check must use the OS account home');
    assert.ok(policy.includes(`(subpath ${JSON.stringify(realpathSync(userInfo().homedir))})`), 'OS account home must be protected independently of HOME');
    assert.ok(policy.includes(`(subpath ${JSON.stringify(alternateHome)})`), 'overridden HOME must also remain protected');
  } finally { rmSync(alternateHome, { recursive: true, force: true }); }
});
