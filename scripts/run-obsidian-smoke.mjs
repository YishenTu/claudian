#!/usr/bin/env node
/* global AbortController, fetch */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CDP, until } from './obsidian-smoke/cdp.mjs';
import { enableTemporaryPlugins, stagePluginBootstrap } from './obsidian-smoke/bootstrap.mjs';
import { checkHost } from './obsidian-smoke/checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'claudian-obsidian-smoke-';
// The child omits HOME, so protect and inspect the OS account home independently of the parent env.
const ACCOUNT_HOME = realpathSync(userInfo().homedir);
const CLI_SOCKET = path.join(ACCOUNT_HOME, '.obsidian-cli.sock');
const HELP = `Usage: npm run smoke:obsidian -- [--app /Applications/Obsidian.app] [--timeout-ms 180000] [--dry-run]

Local macOS smoke test using an installed, unmodified Obsidian. Linux/AppImage and Windows are not supported.
No downloads, credentials, provider prompts, CI integration, or new dependencies. Refuses CI=true.

Builds current source in a fresh temporary checkout and copies only into its fresh temporary vault.
Your checkout's .env.local is NOT copied; any .env.local in the staged build is rejected.
OBSIDIAN_VAULT is explicitly replaced and its canonical destination checked before building.
A new profile disables app updates. An empty-manifest bootstrap cannot show the host trust prompt;
CDP seeds its localStorage trust key before exposing the pre-enabled plugins and reloading.
A role/name fallback handles any trust prompt automatically or fails; human clicks are never required.
CDP moves owned windows off-screen where supported and never requests foreground focus; the host
may briefly activate during initial OS startup. The app stays inside the owned sandbox/process group.

Mandatory macOS sandbox-exec denies writes in the OS account home, any overridden HOME, and the app bundle.
It denies
outbound networking except loopback IP. This protects the existing home CLI socket from Obsidian's
startup unlink and denies Unix-socket connections. It permits system temp/IPC; it is not a read sandbox.
Electron's inner sandbox is disabled only inside this outer sandbox. Refuses to launch without it.
Expected host CLI socket/setup diagnostics stay in launch.log; renderer errors fail the smoke test.

Owned process groups are terminated and the temporary profile/vault/build removed on success,
failure, SIGINT or SIGTERM. Logs and AX snapshots remain in .context/local/obsidian-smoke/<run-id>/.
Tests: plugin/view activation, modal ARIA and native Escape scope ownership (including both snippet
fields), project memory/confirm, shared skill modals, image preview, settings roles, production
fork/Pi modals in-host, Component/ItemView lifecycle, view reopen,
inline editor, unload, and renderer errors. No native-provider, screen-reader or Linux claim.

Options:
  --app PATH         Installed .app bundle (default /Applications/Obsidian.app).
  --timeout-ms N     Total run deadline, 1000–600000 ms (default 180000).
  --dry-run          Print planned temporary paths and sandbox policy; create nothing.
  --help             Show this help without building or launching.
No vault/profile/destination argument is accepted.
`;

export function parseArguments(args) {
  const result = { app: '/Applications/Obsidian.app', timeout: 180_000, help: false, dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help') result.help = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--app' || arg === '--timeout-ms') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for argument ${arg}`);
      if (arg === '--app') result.app = value;
      else {
        if (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 600_000) throw new Error('Invalid timeout: expected 1000–600000 milliseconds');
        result.timeout = Number(value);
      }
    } else throw new Error(`Unknown argument ${arg}; use --help`);
  }
  return result;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertBuildTarget({ tempRoot, vault, checkout, env }) {
  const owned = realpathSync(tempRoot);
  if (!path.basename(owned).startsWith(PREFIX) || !inside(realpathSync(tmpdir()), owned)) throw new Error('Expected a fresh smoke directory under the OS temporary directory');
  const target = realpathSync(vault);
  if (!inside(owned, target)) throw new Error('Build destination must be the owned temporary vault');
  if (!inside(owned, realpathSync(checkout))) throw new Error('Build checkout must be temporary');
  if (env.OBSIDIAN_VAULT !== target) throw new Error('OBSIDIAN_VAULT must explicitly equal the owned temporary vault');
  if (existsSync(path.join(checkout, '.env.local'))) throw new Error('Refusing .env.local in the staged build; it must not override the copy target');
  return target;
}

function sandboxPolicy(appBundle) {
  const homes = [...new Set([ACCOUNT_HOME, realpathSync(homedir())])];
  const protectedHomes = homes.map(home => `(subpath ${JSON.stringify(home)})`).join(' ');
  return `(version 1) (allow default) (deny file-write* ${protectedHomes} (subpath ${JSON.stringify(appBundle)})) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))`;
}

function printPlan(options) {
  const tempRoot = path.join(realpathSync(tmpdir()), `${PREFIX}<mkdtemp>`);
  console.log('Dry run only: no directories, build or app process will be created.');
  console.log(JSON.stringify({
    profile: path.join(tempRoot, 'profile'), vault: path.join(tempRoot, 'vault'),
    checkout: path.join(tempRoot, 'checkout'), stagedPlugins: path.join(tempRoot, 'plugins-ready'),
    OBSIDIAN_VAULT: path.join(tempRoot, 'vault'),
    logs: path.join(ROOT, '.context/local/obsidian-smoke/<run-id>'),
    pluginTrust: 'CDP localStorage enable-plugin-<temporary-appId>=true before exposing manifests',
    app: path.resolve(options.app), cliSocket: CLI_SOCKET,
  }, null, 2));
  console.log(`Sandbox profile:\n${sandboxPolicy(path.resolve(options.app))}`);
}

function socketIdentity(file) {
  try { const stat = lstatSync(file); return { dev: stat.dev, ino: stat.ino, mode: stat.mode }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function runSmoke(options) {
  if (process.platform !== 'darwin') throw new Error('Obsidian smoke supports macOS only; Linux/AppImage and Windows are not supported');
  if (process.env.CI && process.env.CI !== 'false') throw new Error('Obsidian smoke is local-only; refusing CI');
  if (!existsSync('/usr/bin/sandbox-exec')) throw new Error('sandbox-exec is required to protect the real home, app bundle and CLI socket');
  const appBundle = realpathSync(options.app);
  const binary = path.join(appBundle, 'Contents/MacOS/Obsidian');
  if (!appBundle.endsWith('.app') || !existsSync(binary)) throw new Error('Expected an installed Obsidian .app bundle');
  const tempRoot = mkdtempSync(path.join(realpathSync(tmpdir()), PREFIX));
  const profile = path.join(tempRoot, 'profile');
  const vault = path.join(tempRoot, 'vault');
  const checkout = path.join(tempRoot, 'checkout');
  const artifactDir = path.join(ROOT, '.context/local/obsidian-smoke', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  const controller = new AbortController();
  const { signal } = controller;
  const groups = new Set();
  const results = [];
  const previousSocket = socketIdentity(CLI_SOCKET);
  let cdp;
  let signalExit = 0;
  let timeout;
  const interrupt = name => {
    const repeated = signalExit !== 0;
    signalExit = name === 'SIGINT' ? 130 : 143;
    if (repeated) {
      emergencyCleanup();
      process.exit(signalExit);
    }
    controller.abort(new Error(`Interrupted by ${name}`));
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  const kill = (pid, name) => { try { process.kill(-pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  // Last-resort synchronous cleanup also covers an uncaught launcher error.
  const emergencyCleanup = () => {
    for (const pid of groups) { try { kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    groups.clear();
    rmSync(tempRoot, { recursive: true, force: true });
  };
  const check = async (name, operation) => {
    signal.throwIfAborted();
    try {
      const details = await operation();
      results.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
      console.error(`FAIL ${name}: ${error.message}`);
      throw error;
    }
  };
  const launch = (command, args, log, env, cwd) => {
    signal.throwIfAborted();
    const fd = openSync(log, 'a');
    let child;
    try { child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] }); }
    finally { closeSync(fd); }
    if (child.pid) groups.add(child.pid);
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, reason) => resolve({ code, reason }));
    });
    // A background app launch must not create an unhandled rejection before readiness polling.
    void done.catch(() => {});
    return { child, done };
  };
  try {
    mkdirSync(artifactDir, { recursive: true });
    console.log(`Artifacts: ${artifactDir}`);
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm); process.once('exit', emergencyCleanup);
    timeout = setTimeout(() => controller.abort(new Error(`Smoke exceeded ${options.timeout} ms`)), options.timeout);
    for (const directory of [profile, vault, checkout]) mkdirSync(directory);
    await check('isolated-build', async () => {
      for (const name of ['src', 'scripts', 'package.json', 'package-lock.json', 'bun.lock', 'manifest.json', 'tsconfig.json', 'esbuild.config.mjs']) {
        cpSync(path.join(ROOT, name), path.join(checkout, name), { recursive: true });
      }
      symlinkSync(path.join(ROOT, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
      const env = { ...process.env, OBSIDIAN_VAULT: vault };
      delete env.NODE_OPTIONS;
      assertBuildTarget({ tempRoot, vault, checkout, env });
      const building = launch(process.execPath, ['scripts/build.mjs', 'production'], path.join(artifactDir, 'build.log'), env, checkout);
      const aborted = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      const result = await Promise.race([building.done, aborted]);
      assert.equal(result.code, 0, 'Build failed; see build.log');
      groups.delete(building.child.pid);
      const installed = path.join(vault, '.obsidian/plugins/claudian');
      for (const name of ['main.js', 'styles.css', 'manifest.json']) assert.deepEqual(readFileSync(path.join(installed, name)), readFileSync(path.join(checkout, name)), `${name} installed into temp vault`);
    });
    const probeDir = path.join(vault, '.obsidian/plugins/claudian-smoke-probe');
    mkdirSync(probeDir, { recursive: true });
    await build({ absWorkingDir: checkout, entryPoints: ['scripts/obsidian-smoke/probe.mjs'], outfile: path.join(probeDir, 'main.js'), bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
    writeFileSync(path.join(probeDir, 'manifest.json'), JSON.stringify({ id: 'claudian-smoke-probe', name: 'Local smoke probe', version: '1.0.0', minAppVersion: '1.0.0', author: 'Claudian tests', isDesktopOnly: true }));
    writeFileSync(path.join(vault, 'Smoke.md'), '# Smoke fixture\n\nTemporary local host check.\n');
    const skillDir = path.join(vault, '.agents/skills/smoke-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: smoke-skill\ndescription: Temporary local smoke fixture.\n---\nReturn a short greeting.\n');
    writeFileSync(path.join(vault, '.obsidian/app.json'), JSON.stringify({ safeMode: false }));
    const staged = stagePluginBootstrap(vault, tempRoot);
    writeFileSync(path.join(profile, 'obsidian.json'), JSON.stringify({ vaults: { [randomUUID().replaceAll('-', '').slice(0, 16)]: { path: vault, ts: Date.now(), open: true } }, updateDisabled: true, cli: false, language: 'en' }));
    const policy = sandboxPolicy(appBundle);
    const sandbox = path.join(tempRoot, 'sandbox.sb');
    writeFileSync(sandbox, policy);
    writeFileSync(path.join(artifactDir, 'sandbox.sb'), policy);
    const app = launch('/usr/bin/sandbox-exec', ['-f', sandbox, binary, `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], path.join(tempRoot, 'launch.log'), {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8',
    }, tempRoot);
    await check('isolated-host', async () => {
      const portFile = path.join(profile, 'DevToolsActivePort');
      await until(() => {
        if (app.child.exitCode !== null) throw new Error(`Obsidian exited (${app.child.exitCode}); see launch.log`);
        return existsSync(portFile);
      }, 'CDP endpoint', signal, 30_000);
      const port = readFileSync(portFile, 'utf8').split('\n')[0];
      if (!/^\d+$/.test(port)) throw new Error('Invalid owned CDP port');
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal })).json();
      if (!info.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`)) throw new Error('Refusing an unexpected CDP endpoint');
      cdp = new CDP(info.webSocketDebuggerUrl, { signal, eventLog: path.join(artifactDir, 'cdp-events.jsonl') });
      await cdp.start();
      return { browser: info.Browser };
    });
    await check('unattended-plugin-startup', () => enableTemporaryPlugins(cdp, { vault, staged, signal }));
    await checkHost(cdp, { vault, artifactDir, signal, check });
  } catch (error) {
    if (!results.some(result => !result.passed)) { results.push({ name: 'runner', passed: false, error: String(error) }); console.error(`FAIL runner: ${error.message}`); }
  } finally {
    clearTimeout(timeout);
    cdp?.close();
    for (const pid of groups) kill(pid, 'SIGTERM');
    if (groups.size) await delay(800);
    for (const pid of groups) kill(pid, 'SIGKILL');
    groups.clear();
    if (existsSync(path.join(tempRoot, 'launch.log'))) copyFileSync(path.join(tempRoot, 'launch.log'), path.join(artifactDir, 'launch.log'));
    rmSync(tempRoot, { recursive: true, force: true });
    try { assert.deepEqual(socketIdentity(CLI_SOCKET), previousSocket); results.push({ name: 'cli-socket-unchanged', passed: true }); console.log('PASS cli-socket-unchanged'); }
    catch (error) { results.push({ name: 'cli-socket-unchanged', passed: false, error: String(error) }); console.error('FAIL cli-socket-unchanged'); }
    if (existsSync(artifactDir)) {
      writeFileSync(path.join(artifactDir, 'renderer-errors.json'), JSON.stringify(cdp?.errors ?? [], null, 2));
      writeFileSync(path.join(artifactDir, 'results.json'), JSON.stringify({ temporaryRootRemoved: !existsSync(tempRoot), tempRoot, results }, null, 2));
    }
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); process.removeListener('exit', emergencyCleanup);
  }
  return signalExit || (results.every(result => result.passed) ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else if (options.dryRun) printPlan(options);
    else process.exitCode = await runSmoke(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
