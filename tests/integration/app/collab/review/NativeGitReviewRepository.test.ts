import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CollabRequestDetail } from '@claudian-collab/protocol';
import {
  writeGitFixtureBlob,
  writeGitFixtureTree,
} from '@test/helpers/collabGitObjects';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { NativeGitReviewRepository } from '@/app/collab/review/NativeGitReviewRepository';

jest.setTimeout(30_000);

describe('NativeGitReviewRepository integration', () => {
  let root: string;
  let git: GitRepositoryService;
  let runner: GitCommandRunner;
  let gitExecutablePath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-review-'));
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available') {
      throw new Error('Native Git is required for integration tests');
    }
    gitExecutablePath = resolution.runtime.executablePath;
    runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: resolution.runtime.executablePath,
    });
    git = new GitRepositoryService(runner);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it.each(['origin-inspection', 'origin-config', 'fetch-inspection'] as const)(
    'cancels native %s before Review proceeds', async stage => {
      const repositoryPath = path.join(root, 'working');
      await mkdir(repositoryPath);
      await git.initializeWorkingRepository(repositoryPath);
      const remoteUrl = 'https://authority.example.invalid/repository.git';
      await git.addRemote(repositoryPath, 'origin', remoteUrl);
      const marker = path.join(root, 'preflight-started');
      const counter = path.join(root, 'inspection-count');
      const script = path.join(root, 'delayed-git.cjs');
      await writeFile(script, '#!/usr/bin/env node\n' + [
        "const fs = require('node:fs');",
        "const command = process.argv[2];",
        `const counter = ${JSON.stringify(counter)};`,
        "let count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;",
        "if (command === 'rev-parse') fs.writeFileSync(counter, String(++count));",
        `const run = () => { const result = require('node:child_process').spawnSync(${JSON.stringify(gitExecutablePath)}, process.argv.slice(2), { stdio: 'inherit' }); process.exit(result.status ?? 1); };`,
        `const stage = ${JSON.stringify(stage)};`,
        "const delayed = (stage === 'origin-inspection' && command === 'rev-parse' && count === 1) || (stage === 'origin-config' && command === 'config') || (stage === 'fetch-inspection' && command === 'rev-parse' && count === 3);",
        `if (delayed) { fs.writeFileSync(${JSON.stringify(marker)}, 'ready'); setTimeout(run, 5000); } else run();`,
      ].join('\n'), { mode: 0o700 });
      let shim = script;
      if (process.platform === 'win32') {
        shim = path.join(root, 'delayed-git.cmd');
        await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`);
      }
      const delayedRunner = new GitCommandRunner({
        emptyConfigPath: path.join(root, 'empty.gitconfig'), executablePath: shim,
      });
      const repository = new NativeGitReviewRepository(new GitRepositoryService(delayedRunner), {
        withNetwork: async (context, operation) => operation(undefined, context.remoteUrl!),
      });
      const controller = new AbortController();
      const result = repository.prepare({
        memberId: 'member-reviewer', personalRef: 'refs/heads/members/member-reviewer',
        projectId: 'project-a', remoteUrl, repositoryPath, role: 'manager',
      }, requestDetail('a'.repeat(40), 'b'.repeat(40)), controller.signal)
        .then(value => ({ value }), error => ({ error }));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { await access(marker); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      await access(marker);
      const started = performance.now();
      controller.abort();
      expect(await result).toMatchObject({ error: { code: 'cancelled' } });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(delayedRunner.activeProcessCount).toBe(0);
    },
  );

  it('fetches exact authority refs and reads the clean candidate without checkout', async () => {
    const sourcePath = path.join(root, 'source');
    const authorityPath = path.join(root, 'authority.git');
    const clonesPath = path.join(root, 'clones');
    await Promise.all([mkdir(sourcePath), mkdir(authorityPath), mkdir(clonesPath)]);
    await git.initializeWorkingRepository(sourcePath);
    await git.configureLocalRepository(sourcePath, {
      memberId: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      projectId: 'project-a',
      userDisplayName: 'Member A',
    });
    await git.stageAll(sourcePath);
    const mainOid = await git.createCommitFromIndex(sourcePath, {
      expectedRefOid: null,
      message: 'Initial project',
      parents: [],
      ref: 'refs/heads/main',
    });
    const noteBlob = await writeGitFixtureBlob(runner, sourcePath, Buffer.from('review me\n'));
    const memberTree = await writeGitFixtureTree(runner, sourcePath, [{
      mode: '100644',
      oid: noteBlob,
      path: 'note.md',
      type: 'blob',
    }]);
    const headOid = await git.commitTree(sourcePath, {
      message: 'Add note',
      parents: [mainOid],
      treeOid: memberTree,
    });
    await git.createRef(sourcePath, 'refs/heads/members/member-a', headOid);
    await git.initializeBareRepository(authorityPath);
    await git.addRemote(sourcePath, 'origin', authorityPath);
    await git.push(sourcePath, 'origin', 'refs/heads/main:refs/heads/main');
    await git.push(
      sourcePath,
      'origin',
      'refs/heads/members/member-a:refs/heads/members/member-a',
    );

    const repositoryPath = await git.cloneRepository({
      branch: 'main',
      directoryName: 'reviewer',
      parentDirectory: clonesPath,
      remoteUrl: authorityPath,
    });
    const detail = requestDetail(mainOid, headOid);
    const repository = new NativeGitReviewRepository(git, {
      withNetwork: async (context, operation) => operation(undefined, context.remoteUrl!),
    });
    const context = {
      memberId: 'member-reviewer',
      personalRef: 'refs/heads/members/member-reviewer',
      projectId: 'project-a',
      remoteUrl: authorityPath,
      repositoryPath,
      role: 'manager' as const,
    };

    const review = await repository.prepare(context, detail);
    expect(review).toMatchObject({
      comparisonBaseOid: mainOid,
      comparisonKind: 'candidate',
      detail,
      files: [{
        binary: false,
        kind: 'added',
        largeForReview: false,
        newBytes: 10,
        path: 'note.md',
      }],
      projectId: 'project-a',
    });
    await expect(repository.readFile(context, {
      comparisonBaseOid: review.comparisonBaseOid,
      comparisonTargetOid: review.comparisonTargetOid,
      file: review.files[0],
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toEqual({
      file: review.files[0],
      kind: 'text',
      newText: 'review me\n',
      oldText: null,
    });
    await expect(git.resolveRef(repositoryPath, 'HEAD')).resolves.toBe(mainOid);
  });
});

function requestDetail(mainOid: string, headOid: string): CollabRequestDetail {
  return {
    comments: { comments: [] },
    currentMainOid: mainOid,
    request: {
      commentCount: 0,
      createdAt: '2026-08-08T00:00:00.000Z',
      description: 'Published change',
      firstBaseOid: mainOid,
      id: 'request-a',
      latestHeadOid: headOid,
      memberId: 'member-a',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: '2026-08-08T00:00:00.000Z',
    },
    reviewCondition: 'clean',
    reviewedHeadOid: headOid,
  };
}
