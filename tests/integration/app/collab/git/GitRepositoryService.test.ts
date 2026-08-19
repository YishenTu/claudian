import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  writeGitFixtureBlob,
  writeGitFixtureTree,
} from '@test/helpers/collabGitObjects';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import {
  type GitRepositoryReadSession,
  GitRepositoryService,
} from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';

jest.setTimeout(30_000);

describe('GitRepositoryService integration', () => {
  let root: string;
  let gitExecutablePath: string;
  let runner: GitCommandRunner;
  let service: GitRepositoryService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-git-repository-'));
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available') {
      throw new Error('Native Git is required for integration tests');
    }
    gitExecutablePath = resolution.runtime.executablePath;
    runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: gitExecutablePath,
    });
    service = new GitRepositoryService(runner);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('creates commits, parses status, reads objects and diffs, and preserves refs', async () => {
    const repositoryPath = path.join(root, 'working');
    await mkdir(repositoryPath);
    await service.initializeWorkingRepository(repositoryPath);
    await service.configureLocalRepository(repositoryPath, {
      memberId: 'member-alice',
      personalRef: 'refs/heads/members/member-alice',
      projectId: 'project-alpha',
      userDisplayName: 'Alice',
    });
    await expect(service.assertLocalRepositoryIdentity(repositoryPath, {
      memberId: 'member-alice',
      personalRef: 'refs/heads/members/member-alice',
      projectId: 'project-alpha',
    })).resolves.toBeUndefined();
    await expect(service.assertLocalRepositoryIdentity(repositoryPath, {
      memberId: 'member-alice',
      personalRef: 'refs/heads/members/member-alice',
      projectId: 'project-other',
    })).rejects.toMatchObject({
      code: 'repository-invalid',
      safeContext: { reason: 'collab-local-config-mismatch' },
    });

    await service.stageAll(repositoryPath);
    const rootOid = await service.createCommitFromIndex(repositoryPath, {
      message: 'Initial project',
      parents: [],
      ref: 'refs/heads/main',
      expectedRefOid: null,
    });
    expect(await service.resolveRef(repositoryPath, 'refs/heads/main')).toBe(rootOid);

    await writeFile(path.join(repositoryPath, 'note.md'), 'first\n');
    const dirty = await service.getWorkingTreeStatus(repositoryPath);
    expect(dirty).toEqual([{
      indexStatus: '?',
      kind: 'untracked',
      path: 'note.md',
      worktreeStatus: '?',
    }]);
    await service.stageAll(repositoryPath);
    const headOid = await service.createCommitFromIndex(repositoryPath, {
      expectedRefOid: rootOid,
      message: 'Add note',
      parents: [rootOid],
      ref: 'refs/heads/main',
    });

    expect(await service.getWorkingTreeStatus(repositoryPath)).toEqual([]);
    expect(await service.listChangedFiles(repositoryPath, rootOid, headOid)).toEqual([
      { kind: 'added', path: 'note.md' },
    ]);
    expect(await service.listChangedBlobs(repositoryPath, rootOid, headOid)).toEqual([
      {
        kind: 'added',
        newOid: expect.stringMatching(/^[0-9a-f]{40,64}$/),
        newSize: 6,
        path: 'note.md',
      },
    ]);
    await writeFile(path.join(repositoryPath, 'note.md'), 'working revision\n');
    await writeFile(path.join(repositoryPath, 'untracked.md'), 'draft\n');
    expect(await service.listWorkingTreeChangedFiles(repositoryPath, rootOid)).toEqual([
      { kind: 'added', path: 'note.md' },
      { kind: 'added', path: 'untracked.md' },
    ]);
    expect(await service.listTreeRecursive(repositoryPath, headOid)).toEqual([
      {
        mode: '100644',
        oid: expect.stringMatching(/^[0-9a-f]{40,64}$/),
        path: 'note.md',
        size: 6,
        type: 'blob',
      },
    ]);
    await expect(service.readBlobAtPath(repositoryPath, headOid, 'note.md'))
      .resolves.toEqual(Buffer.from('first\n'));
    await expect(service.readBlobsAtPaths(repositoryPath, [
      { repositoryRelativePath: 'note.md', treeish: headOid },
      { repositoryRelativePath: 'missing note.md', treeish: headOid },
    ])).resolves.toEqual([Buffer.from('first\n'), null]);
    await service.createRef(repositoryPath, 'refs/heads/members/member-alice', headOid);
    expect(await service.resolveRef(
      repositoryPath,
      'refs/heads/members/member-alice',
    )).toBe(headOid);
    await expect(service.assertHealthy(repositoryPath)).resolves.toBeUndefined();
  });

  it('reuses repository validation only inside an explicit read session', async () => {
    const repositoryPath = path.join(root, 'read-session');
    await mkdir(repositoryPath);
    await service.initializeWorkingRepository(repositoryPath);
    await service.configureLocalRepository(repositoryPath, {
      memberId: 'member-reader',
      personalRef: 'refs/heads/members/member-reader',
      projectId: 'project-read-session',
      userDisplayName: 'Reader',
    });
    await service.stageAll(repositoryPath);
    const headOid = await service.createCommitFromIndex(repositoryPath, {
      expectedRefOid: null,
      message: 'Initial project',
      parents: [],
      ref: 'refs/heads/main',
    });
    const runSpy = jest.spyOn(runner, 'run');
    runSpy.mockClear();
    let escaped: GitRepositoryReadSession | undefined;

    const values = await service.withReadSession(repositoryPath, 'working', async session => {
      escaped = session;
      return Promise.all([
        session.resolveRef('refs/heads/main'),
        session.resolveRefs(['refs/heads/main', 'refs/heads/missing']),
        session.getWorkingTreeStatus(),
      ]);
    });

    expect(values).toEqual([
      headOid,
      new Map([
        ['refs/heads/main', headOid],
        ['refs/heads/missing', null],
      ]),
      [],
    ]);
    expect(runSpy.mock.calls.filter(([input]) => (
      input.args[0] === 'rev-parse' && input.args.includes('--absolute-git-dir')
    ))).toHaveLength(1);
    await expect(escaped!.resolveRef('refs/heads/main')).rejects.toMatchObject({
      code: 'repository-invalid',
      safeContext: { reason: 'git-read-session-expired' },
    });

    runSpy.mockClear();
    await service.resolveRef(repositoryPath, 'refs/heads/main');
    await service.resolveRef(repositoryPath, 'refs/heads/main');
    expect(runSpy.mock.calls.filter(([input]) => (
      input.args[0] === 'rev-parse' && input.args.includes('--absolute-git-dir')
    ))).toHaveLength(2);
  });

  it('writes clean and conflicting merge trees and advances refs only by CAS', async () => {
    const repositoryPath = path.join(root, 'merge-repository');
    await mkdir(repositoryPath);
    await service.initializeWorkingRepository(repositoryPath);
    await service.configureLocalRepository(repositoryPath, {
      memberId: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      projectId: 'project-merge',
      userDisplayName: 'Manager',
    });

    const baseBlob = await writeGitFixtureBlob(runner, repositoryPath, Buffer.from('base\n'));
    const acceptedBlob = await writeGitFixtureBlob(
      runner,
      repositoryPath,
      Buffer.from('accepted\n'),
    );
    const memberBlob = await writeGitFixtureBlob(
      runner,
      repositoryPath,
      Buffer.from('member\n'),
    );
    const extraBlob = await writeGitFixtureBlob(runner, repositoryPath, Buffer.from('extra\n'));
    const baseTree = await writeGitFixtureTree(runner, repositoryPath, [
      { mode: '100644', oid: baseBlob, path: 'note.md', type: 'blob' },
    ]);
    const baseCommit = await service.commitTree(repositoryPath, {
      message: 'Base',
      parents: [],
      treeOid: baseTree,
    });
    const acceptedTree = await writeGitFixtureTree(runner, repositoryPath, [
      { mode: '100644', oid: acceptedBlob, path: 'note.md', type: 'blob' },
      { mode: '100644', oid: acceptedBlob, path: 'accepted.md', type: 'blob' },
    ]);
    const memberTree = await writeGitFixtureTree(runner, repositoryPath, [
      { mode: '100644', oid: baseBlob, path: 'note.md', type: 'blob' },
      { mode: '100644', oid: extraBlob, path: 'member.md', type: 'blob' },
    ]);
    const conflictTree = await writeGitFixtureTree(runner, repositoryPath, [
      { mode: '100644', oid: memberBlob, path: 'note.md', type: 'blob' },
    ]);
    const acceptedCommit = await service.commitTree(repositoryPath, {
      identity: {
        email: 'collab@claudian.local',
        name: 'Claudian Collab',
      },
      message: 'Accepted',
      parents: [baseCommit],
      treeOid: acceptedTree,
    });
    const acceptedIdentity = await runner.run({
      args: ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', acceptedCommit],
      cwd: repositoryPath,
    });
    expect(acceptedIdentity.stdout.toString('utf8').trim()).toBe(
      'Claudian Collab\0collab@claudian.local\0Claudian Collab\0collab@claudian.local',
    );
    const memberCommit = await service.commitTree(repositoryPath, {
      message: 'Member',
      parents: [baseCommit],
      treeOid: memberTree,
    });
    const conflictingCommit = await service.commitTree(repositoryPath, {
      message: 'Conflicting member',
      parents: [baseCommit],
      treeOid: conflictTree,
    });

    await expect(service.mergeTree(repositoryPath, acceptedCommit, memberCommit))
      .resolves.toMatchObject({ kind: 'clean', treeOid: expect.stringMatching(/^[0-9a-f]{40,64}$/) });
    await expect(service.mergeTree(repositoryPath, acceptedCommit, conflictingCommit))
      .resolves.toMatchObject({ kind: 'conflicting' });

    await service.createRef(repositoryPath, 'refs/heads/main', baseCommit);
    await expect(service.compareAndSwapRef(
      repositoryPath,
      'refs/heads/main',
      acceptedCommit,
      baseCommit,
    )).resolves.toEqual({ currentOid: acceptedCommit, updated: true });
    await expect(service.compareAndSwapRef(
      repositoryPath,
      'refs/heads/main',
      memberCommit,
      baseCommit,
    )).resolves.toEqual({ currentOid: acceptedCommit, updated: false });
    await service.createRef(repositoryPath, 'refs/heads/members/expired', baseCommit);
    await expect(service.deleteRefIfMatches(
      repositoryPath,
      'refs/heads/members/expired',
      memberCommit,
    )).resolves.toEqual({ currentOid: baseCommit, updated: false });
    await expect(service.deleteRefIfMatches(
      repositoryPath,
      'refs/heads/members/expired',
      baseCommit,
    )).resolves.toEqual({ currentOid: null, updated: true });
    await expect(service.resolveRef(
      repositoryPath,
      'refs/heads/members/expired',
    )).resolves.toBeNull();
    expect(await service.isAncestor(repositoryPath, baseCommit, acceptedCommit)).toBe(true);
    expect(await service.isAncestor(repositoryPath, memberCommit, acceptedCommit)).toBe(false);
    await expect(service.findMergeBase(repositoryPath, acceptedCommit, memberCommit))
      .resolves.toBe(baseCommit);
    await expect(service.countDivergence(repositoryPath, acceptedCommit, memberCommit))
      .resolves.toEqual({ leftOnly: 1, rightOnly: 1 });
  });

  it('initializes a bare authority, installs an executable hook, and clones refs', async () => {
    const sourcePath = path.join(root, 'source');
    const barePath = path.join(root, 'authority.git');
    const cloneParent = path.join(root, 'clones');
    await mkdir(sourcePath);
    await mkdir(barePath);
    await mkdir(cloneParent);
    await service.initializeWorkingRepository(sourcePath);
    await service.configureLocalRepository(sourcePath, {
      memberId: 'member-host',
      personalRef: 'refs/heads/members/member-host',
      projectId: 'project-host',
      userDisplayName: 'Host',
    });
    await service.stageAll(sourcePath);
    const mainOid = await service.createCommitFromIndex(sourcePath, {
      expectedRefOid: null,
      message: 'Initial project',
      parents: [],
      ref: 'refs/heads/main',
    });
    await service.initializeBareRepository(barePath);
    await service.configureHostedRepository(barePath);
    const receiveFsck = await runner.run({
      args: ['config', '--local', '--get', 'receive.fsckObjects'],
      cwd: barePath,
    });
    expect(receiveFsck.stdout.toString('utf8').trim()).toBe('true');
    const initialStorageBytes = await service.measureStorageBytes(barePath);
    expect(initialStorageBytes).toBeGreaterThan(0);
    await service.addRemote(sourcePath, 'origin', barePath);
    await expect(service.listRemoteUrls(sourcePath, 'origin')).resolves.toEqual([barePath]);
    await service.push(sourcePath, 'origin', 'refs/heads/main:refs/heads/main');
    await service.createRef(sourcePath, 'refs/heads/members/member-host', mainOid);
    await service.push(
      sourcePath,
      'origin',
      'refs/heads/members/member-host:refs/heads/members/member-host',
    );

    const hookContents = '#!/bin/sh\nexit 0\n';
    const hookPath = await service.installHook(barePath, 'pre-receive', hookContents);
    expect(await readFile(hookPath, 'utf8')).toBe(hookContents);
    const hookIsExecutable = process.platform === 'win32'
      || await access(hookPath, 1).then(() => true, () => false);
    expect(hookIsExecutable).toBe(true);

    const clonePath = await service.cloneRepository({
      directoryName: 'member-clone',
      parentDirectory: cloneParent,
      remoteUrl: barePath,
    });
    expect(clonePath).toBe(path.join(cloneParent, 'member-clone'));
    expect(await service.resolveRef(clonePath, 'refs/heads/main')).toBe(mainOid);
    await expect(service.getWorkingTreeState(clonePath)).resolves.toMatchObject({
      branch: {
        aheadBy: 0,
        behindBy: 0,
        headName: 'main',
        headOid: mainOid,
        upstreamName: 'origin/main',
      },
      entries: [],
    });
    const fetchRefspecs = await runner.run({
      args: ['config', '--local', '--get-all', 'remote.origin.fetch'],
      cwd: clonePath,
    });
    expect(fetchRefspecs.stdout.toString('utf8').trim().split('\n')).toEqual([
      '+refs/heads/main:refs/remotes/origin/main',
      '+refs/heads/members/*:refs/remotes/origin/members/*',
    ]);
    await expect(service.fetch(clonePath, 'origin', ['+refs/heads/main:refs/remotes/origin/main']))
      .resolves.toBeUndefined();
    await expect(service.assertHealthy(barePath)).resolves.toBeUndefined();
    expect(await service.measureStorageBytes(barePath)).toBeGreaterThan(initialStorageBytes);
    expect((await stat(path.join(clonePath, '.git'))).isDirectory()).toBe(true);

    const personalClonePath = await service.cloneRepository({
      branch: 'members/member-host',
      directoryName: 'personal-clone',
      parentDirectory: cloneParent,
      remoteUrl: barePath,
    });
    expect(await service.resolveRef(
      personalClonePath,
      'refs/heads/members/member-host',
    )).toBe(mainOid);
  });

  it('requires the configured personal ref to match the member identity', async () => {
    const repositoryPath = path.join(root, 'invalid-config');
    await mkdir(repositoryPath);
    await service.initializeWorkingRepository(repositoryPath);

    await expect(service.configureLocalRepository(repositoryPath, {
      memberId: 'member-alice',
      personalRef: 'refs/heads/members/member-bob',
      projectId: 'project-alpha',
      userDisplayName: 'Alice',
    })).rejects.toMatchObject({
      code: 'repository-invalid',
      safeContext: { reason: 'collab-personal-ref-mismatch' },
    });
  });

  it('does not invoke hostile global or local credential helpers', async () => {
    const hostileHome = path.join(root, 'hostile-home');
    const repositoryPath = path.join(root, 'hostile-repository');
    const markerPath = path.join(root, 'helper-invoked');
    const isolatedConfigPath = path.join(root, 'isolated.gitconfig');
    await mkdir(hostileHome);
    await mkdir(repositoryPath);
    await writeFile(isolatedConfigPath, '');
    await writeFile(path.join(hostileHome, '.gitconfig'), [
      '[credential]',
      `\thelper = !touch ${markerPath}`,
      '[user]',
      '\tname = Hostile Global User',
      '\temail = hostile@example.test',
      '',
    ].join('\n'));
    const hostileRunner = new GitCommandRunner({
      baseEnvironment: { ...process.env, HOME: hostileHome },
      emptyConfigPath: isolatedConfigPath,
      executablePath: gitExecutablePath,
    });
    const hostileService = new GitRepositoryService(hostileRunner);
    await hostileService.initializeWorkingRepository(repositoryPath);
    await hostileRunner.run({
      args: [
        'config',
        '--local',
        '--replace-all',
        'credential.helper',
        `!touch ${markerPath}`,
      ],
      cwd: repositoryPath,
    });

    await hostileRunner.run({
      acceptedExitCodes: [0, 128],
      args: ['credential', 'fill'],
      cwd: repositoryPath,
      stdin: 'protocol=https\nhost=127.0.0.1\n\n',
    });

    await expect(stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(isolatedConfigPath, 'utf8')).toBe('');
  });
});
