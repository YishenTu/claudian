import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildIsolatedGitEnvironment,
  GitCommandRunner,
  parseGitNulFields,
} from '@/app/collab/git/GitCommandRunner';

describe('GitCommandRunner', () => {
  let workingDirectory: string;
  let emptyConfigPath: string;

  beforeEach(async () => {
    workingDirectory = await mkdtemp(path.join(tmpdir(), 'claudian-git-runner-'));
    emptyConfigPath = path.join(workingDirectory, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
  });

  afterEach(async () => {
    await rm(workingDirectory, { force: true, recursive: true });
  });

  it('builds an isolated noninteractive environment with secrets outside argv', () => {
    const secret = 'Basic member-secret';
    const environment = buildIsolatedGitEnvironment({
      baseEnvironment: {
        GIT_ASKPASS: '/hostile/askpass',
        GIT_AUTHOR_NAME: 'Global Author',
        GIT_CONFIG_COUNT: '99',
        GIT_CONFIG_KEY_0: 'alias.status',
        GIT_CONFIG_PARAMETERS: "'credential.helper'='hostile'",
        GIT_CONFIG_VALUE_0: '!hostile',
        HOME: '/test/home',
        LC_ALL: 'fr_FR.UTF-8',
        PATH: '/usr/bin',
      },
      emptyConfigPath,
      network: {
        headers: [
          { name: 'Authorization', value: secret },
          { name: 'X-Claudian-Development-Actor', value: 'member-alice' },
        ],
        sslCaInfoPath: '/vault/.claudian/collab/ca.pem',
      },
      platform: 'win32',
    });

    expect(environment).toMatchObject({
      GIT_ASKPASS: '',
      GIT_CONFIG_GLOBAL: emptyConfigPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: emptyConfigPath,
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C',
      LC_ALL: 'C',
      SSH_ASKPASS: '',
    });
    expect(environment).not.toHaveProperty('GIT_AUTHOR_NAME');
    expect(environment).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
    const configCount = Number(environment.GIT_CONFIG_COUNT);
    const runtimeConfig = Array.from({ length: configCount }, (_, index) => ({
      key: environment[`GIT_CONFIG_KEY_${index}`],
      value: environment[`GIT_CONFIG_VALUE_${index}`],
    }));
    expect(runtimeConfig).toEqual(expect.arrayContaining([
      { key: 'credential.helper', value: '' },
      { key: 'credential.useHttpPath', value: 'true' },
      { key: 'fetch.fsckObjects', value: 'true' },
      { key: 'http.extraHeader', value: `Authorization: ${secret}` },
      {
        key: 'http.extraHeader',
        value: 'X-Claudian-Development-Actor: member-alice',
      },
      { key: 'http.schannelCheckRevoke', value: 'false' },
      { key: 'http.schannelUseSSLCAInfo', value: 'true' },
      { key: 'http.sslBackend', value: 'schannel' },
      { key: 'http.sslCAInfo', value: '/vault/.claudian/collab/ca.pem' },
      { key: 'transfer.fsckObjects', value: 'true' },
    ]));

    const posixEnvironment = buildIsolatedGitEnvironment({
      emptyConfigPath,
      network: {
        headers: [{ name: 'Authorization', value: secret }],
        sslCaInfoPath: '/vault/.claudian/collab/ca.pem',
      },
      platform: 'linux',
    });
    const posixConfigKeys = Array.from(
      { length: Number(posixEnvironment.GIT_CONFIG_COUNT) },
      (_, index) => posixEnvironment[`GIT_CONFIG_KEY_${index}`],
    );
    expect(posixConfigKeys).not.toContain('http.sslBackend');
    expect(posixConfigKeys).not.toContain('http.schannelCheckRevoke');
    expect(posixConfigKeys).not.toContain('http.schannelUseSSLCAInfo');
  });

  it('scopes a validated commit identity to one isolated process environment', () => {
    const environment = buildIsolatedGitEnvironment({
      baseEnvironment: {
        GIT_AUTHOR_NAME: 'Inherited Author',
        GIT_COMMITTER_EMAIL: 'inherited@example.test',
      },
      emptyConfigPath,
      identity: {
        email: 'collab@claudian.local',
        name: 'Claudian Collab',
      },
    });

    expect(environment).toMatchObject({
      GIT_AUTHOR_EMAIL: 'collab@claudian.local',
      GIT_AUTHOR_NAME: 'Claudian Collab',
      GIT_COMMITTER_EMAIL: 'collab@claudian.local',
      GIT_COMMITTER_NAME: 'Claudian Collab',
    });
    expect(() => buildIsolatedGitEnvironment({
      emptyConfigPath,
      identity: { email: 'collab@claudian.local', name: 'Injected\nAuthor' },
    })).toThrow(expect.objectContaining({
      safeContext: { reason: 'unsafe-git-identity' },
    }));
  });

  it('suppresses repository hooks only for commands that explicitly request it', () => {
    const normal = buildIsolatedGitEnvironment({ emptyConfigPath });
    const suppressed = buildIsolatedGitEnvironment({
      emptyConfigPath,
      suppressHooks: true,
    });
    const readRuntimeConfig = (environment: NodeJS.ProcessEnv) => Array.from(
      { length: Number(environment.GIT_CONFIG_COUNT) },
      (_, index) => ({
        key: environment[`GIT_CONFIG_KEY_${index}`],
        value: environment[`GIT_CONFIG_VALUE_${index}`],
      }),
    );

    expect(readRuntimeConfig(normal)).not.toContainEqual({
      key: 'core.hooksPath',
      value: emptyConfigPath,
    });
    expect(readRuntimeConfig(suppressed)).toContainEqual({
      key: 'core.hooksPath',
      value: emptyConfigPath,
    });
  });

  it('collects bounded output and parses strict NUL-delimited fields', async () => {
    const runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: process.execPath,
    });

    const result = await runner.run({
      args: ['-e', "process.stdout.write(Buffer.from('one\\0two\\0'))"],
      cwd: workingDirectory,
    });

    expect(parseGitNulFields(result.stdout)).toEqual(['one', 'two']);
    expect(() => parseGitNulFields(Buffer.from('missing terminator'))).toThrow();
    expect(() => parseGitNulFields(Buffer.from([0xff, 0x00]))).toThrow();
  });

  it('aborts a running child and waits for process cleanup', async () => {
    const runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: process.execPath,
      terminationGraceMs: 50,
    });
    const controller = new AbortController();
    const execution = runner.run({
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      cwd: workingDirectory,
      signal: controller.signal,
    });

    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: 'cancelled' });
    expect(runner.activeProcessCount).toBe(0);
  });

  it('terminates commands that exceed their timeout or output cap', async () => {
    const runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: process.execPath,
      terminationGraceMs: 50,
    });

    await expect(runner.run({
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      cwd: workingDirectory,
      timeoutMs: 20,
    })).rejects.toMatchObject({
      code: 'operation-timeout',
    });
    await expect(runner.run({
      args: ['-e', "process.stdout.write('x'.repeat(1024))"],
      cwd: workingDirectory,
      maxStdoutBytes: 32,
    })).rejects.toMatchObject({
      code: 'quota-exceeded',
      safeContext: { reason: 'git-output-limit' },
    });
    expect(runner.activeProcessCount).toBe(0);
  });

  it('redacts credentials and absolute paths from command failures', async () => {
    const secret = 'member-secret-that-must-not-leak';
    const runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: process.execPath,
    });

    let failure: unknown;
    try {
      await runner.run({
        args: [
          '-e',
          "const value = Object.entries(process.env).find(([key, item]) => key.startsWith('GIT_CONFIG_VALUE_') && item?.startsWith('Author' + 'ization:'))?.[1]; process.stderr.write(`${value} at ${process.cwd()}/repo`); process.exit(7)",
        ],
        cwd: workingDirectory,
        network: {
          headers: [{ name: 'Authorization', value: `Basic ${secret}` }],
          sslCaInfoPath: emptyConfigPath,
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'operation-failed',
      safeContext: {
        exitCode: 7,
        status: expect.any(String),
      },
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(workingDirectory);
  });

  it('never places a network authorization value in process arguments', async () => {
    const authorizationHeader = 'Basic another-member-secret';
    const runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: process.execPath,
    });

    const result = await runner.run({
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'],
      cwd: workingDirectory,
      network: {
        headers: [{ name: 'Authorization', value: authorizationHeader }],
        sslCaInfoPath: emptyConfigPath,
      },
    });

    expect(result.stdout.toString('utf8')).not.toContain(authorizationHeader);
  });

  it('rejects config-scope mutation and argument-carried secrets before spawn', async () => {
    const runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: process.execPath,
    });

    await expect(runner.run({
      args: ['config', '--global', 'credential.helper', '!hostile'],
      cwd: workingDirectory,
    })).rejects.toMatchObject({
      safeContext: { reason: 'unsafe-git-argument' },
    });
    await expect(runner.run({
      args: ['fetch', 'https://member:secret@example.test/repository.git'],
      cwd: workingDirectory,
      sensitiveValues: ['secret'],
    })).rejects.toMatchObject({
      safeContext: { reason: 'unsafe-git-argument' },
    });
    await expect(readFile(emptyConfigPath, 'utf8')).resolves.toBe('');
  });

  it('rejects injected authorization headers and relative CA paths before spawn', async () => {
    const runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: process.execPath,
    });

    await expect(runner.run({
      args: ['--version'],
      cwd: workingDirectory,
      network: {
        headers: [{
          name: 'Authorization',
          value: 'Basic safe\r\nX-Injected: true',
        }],
        sslCaInfoPath: emptyConfigPath,
      },
    })).rejects.toMatchObject({
      safeContext: { reason: 'unsafe-git-network-environment' },
    });
    await expect(runner.run({
      args: ['--version'],
      cwd: workingDirectory,
      network: {
        headers: [{ name: 'Authorization', value: 'Bearer safe-token' }],
        sslCaInfoPath: 'relative-ca.pem',
      },
    })).rejects.toMatchObject({
      safeContext: { reason: 'unsafe-git-network-environment' },
    });
    expect(runner.activeProcessCount).toBe(0);
  });
});
