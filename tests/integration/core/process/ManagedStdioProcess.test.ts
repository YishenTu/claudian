import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ManagedStdioProcess,
  type ManagedStdioProcessExitState,
  type ManagedStdioProcessOptions,
} from '@/core/process/ManagedStdioProcess';

jest.setTimeout(45_000);

let directory: string;
const processes: ManagedStdioProcess[] = [];
const readers: Interface[] = [];
const pids = new Set<number>();

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), 'claudian native 文档 ')));
});

afterEach(async () => {
  // Independent cleanup must also work when the production shutdown path is broken.
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  await Promise.all(processes.map(managed => managed.shutdown()));
  readers.splice(0).forEach(reader => reader.close());
  processes.splice(0).forEach(managed => {
    managed.stdin.destroy(); managed.stdout.destroy(); managed.stderr.destroy();
  });
  pids.clear();
  await rm(directory, { recursive: true, force: true });
});

async function launch(
  source: string,
  args: string[] = [],
  options: Partial<ManagedStdioProcessOptions> = {},
  commandShim = false,
) {
  const script = path.join(directory, 'native fixture.cjs');
  await writeFile(script, `setTimeout(() => process.exit(99), 60_000).unref();\n${source}`);
  let command = process.execPath;
  let launchArgs = [script, ...args];
  if (commandShim) {
    command = path.join(directory, 'provider & tools.cmd');
    await writeFile(command, '@echo off\r\n"%CLAUDIAN_NATIVE_NODE%" "%~dp0native fixture.cjs" %*\r\n');
    launchArgs = args;
  }
  const managed = new ManagedStdioProcess({
    command, args: launchArgs, cwd: directory, env: { ...process.env, CLAUDIAN_NATIVE_TEST: 'env 文档', CLAUDIAN_NATIVE_NODE: process.execPath },
    ...options,
  });
  const closed = new Promise<ManagedStdioProcessExitState>(resolve => managed.onClose(resolve));
  managed.start();
  processes.push(managed);
  const reader = createInterface({ input: managed.stdout });
  readers.push(reader);
  const lines = reader[Symbol.asyncIterator]();
  return {
    managed,
    closed,
    async readRecord() {
      const line = await withinDeadline(lines.next(), managed);
      if (line.done) throw new Error(`Fixture closed before replying: ${managed.getStderrSnapshot()}`);
      const record = JSON.parse(line.value);
      if (typeof record.pid === 'number') pids.add(record.pid);
      if (typeof record.childPid === 'number') pids.add(record.childPid);
      return record;
    },
  };
}

async function withinDeadline<T>(pending: Promise<T>, managed: ManagedStdioProcess): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Native process did not respond: ${JSON.stringify(managed.getExitState())}; ${managed.getStderrSnapshot()}`,
        )), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        pids.delete(pid);
        return;
      }
      throw error;
    }
    await delay(25);
  }
  throw new Error(`Native fixture process ${pid} survived shutdown`);
}

it('delivers opaque arguments, cwd, environment and stdin through a real executable', async () => {
  const args = ['', 'two words', 'line one\r\nline two', '"quoted" %PATH% !caret^ & | < >', '文档\\session.jsonl'];
  const payload = { text: 'stdin 文档\nsecond line' };
  const { managed, closed, readRecord } = await launch(`
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      process.stderr.write('diagnostic only');
      process.stdout.write(JSON.stringify({
        args: process.argv.slice(2), cwd: process.cwd(),
        environment: process.env.CLAUDIAN_NATIVE_TEST, input: JSON.parse(input),
      }) + '\\n');
    });
  `, args);
  managed.stdin.end(JSON.stringify(payload));
  expect(await readRecord()).toEqual({ args, cwd: directory, environment: 'env 文档', input: payload });
  expect(await withinDeadline(closed, managed)).toMatchObject({ closed: true, code: 0, signal: null });
  expect(managed.getStderrSnapshot()).toBe('diagnostic only');
  expect(managed.isAlive()).toBe(false);
});

it('terminates a running child when shutdown is requested repeatedly', async () => {
  const { managed, closed, readRecord } = await launch(`
    setInterval(() => {}, 1000);
    process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n');
  `);
  const { pid } = await readRecord();
  expect(managed.isAlive()).toBe(true);
  await Promise.all([managed.shutdown(), managed.shutdown()]);
  expect(await withinDeadline(closed, managed)).toMatchObject({ closed: true });
  await expectProcessGone(pid);
  expect(managed.isAlive()).toBe(false);
});

const describeOnPOSIX = process.platform === 'win32' ? describe.skip : describe;
describeOnPOSIX('POSIX signals', () => {
  it.each([
    { behavior: 'exits gracefully', exit: 'process.exit(0);', code: 0, signal: null },
    { behavior: 'ignores SIGTERM', exit: '', code: null, signal: 'SIGKILL' },
  ])('shuts down a child that $behavior', async ({ exit, code, signal }) => {
    const { managed, closed, readRecord } = await launch(`
      process.on('SIGTERM', () => { process.stderr.write('received SIGTERM'); ${exit} });
      setInterval(() => {}, 1000);
      process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n');
    `, [], { sigkillTimeoutMs: 500 });
    const { pid } = await readRecord();
    await managed.shutdown();
    expect(await withinDeadline(closed, managed)).toMatchObject({ code, signal });
    expect(managed.getStderrSnapshot()).toBe('received SIGTERM');
    await expectProcessGone(pid);
  });
});

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;
describeOnWindows('Windows command shims', () => {
  it('delivers command-shim arguments and kills the actual descendant process tree', async () => {
    const args = ['two words', 'R&D', '"quoted"', '文档\\session.jsonl'];
    const { managed, closed, readRecord } = await launch(`
      const child = require('node:child_process').spawn(process.execPath, ['-e',
        "setInterval(() => {}, 1000); setTimeout(() => process.exit(99), 60000).unref(); process.stdout.write('ready');"
      ], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.on('error', error => { process.stderr.write(String(error)); process.exit(1); });
      child.stdout.once('data', () => process.stdout.write(JSON.stringify({
        pid: process.pid, childPid: child.pid, args: process.argv.slice(2),
      }) + '\\n'));
      setInterval(() => {}, 1000);
    `, args, {}, true);
    const record = await readRecord();
    expect(record.args).toEqual(args);
    expect(typeof record.pid).toBe('number');
    expect(typeof record.childPid).toBe('number');
    process.kill(record.pid, 0);
    process.kill(record.childPid, 0);
    await managed.shutdown();
    await withinDeadline(closed, managed);
    await Promise.all([expectProcessGone(record.pid), expectProcessGone(record.childPid)]);
  });
});
