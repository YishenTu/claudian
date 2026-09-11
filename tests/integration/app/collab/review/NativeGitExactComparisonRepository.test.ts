import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeGitFixtureBlob, writeGitFixtureTree } from '@test/helpers/collabGitObjects';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { NativeGitExactComparisonRepository } from '@/app/collab/review/NativeGitExactComparisonRepository';

jest.setTimeout(30_000);

describe('NativeGitExactComparisonRepository resource bounds', () => {
  let root: string;
  let runner: GitCommandRunner;
  let git: GitRepositoryService;
  let executablePath: string;
  let emptyConfigPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-exact-review-'));
    emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available') throw new Error('Native Git is required');
    executablePath = resolution.runtime.executablePath;
    runner = new GitCommandRunner({ emptyConfigPath, executablePath });
    git = new GitRepositoryService(runner);
    await git.initializeWorkingRepository(root);
    await runner.run({ args: ['config', '--local', 'user.useConfigOnly', 'true'], cwd: root });
    await git.configureLocalRepository(root, {
      memberId: 'member-reviewer',
      personalRef: 'refs/heads/members/member-reviewer',
      projectId: 'project-review',
      userDisplayName: 'Review Fixture',
    });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  async function fixture(bytes: number): Promise<{ base: string; target: string }> {
    const commit = async (contents: Buffer, parents: string[]) => git.commitTree(root, {
      message: 'Review fixture',
      parents,
      treeOid: await writeGitFixtureTree(runner, root, [{
        mode: '100644',
        oid: await writeGitFixtureBlob(runner, root, contents),
        path: 'large note.md',
        type: 'blob',
      }]),
    });
    const base = await commit(Buffer.alloc(bytes, 'a'), []);
    return { base, target: await commit(Buffer.alloc(bytes, 'b'), [base]) };
  }

  it('returns oversized text metadata without transferring full blobs from Git', async () => {
    const { base, target } = await fixture(12 * 1024 * 1024);
    const comparisons = new NativeGitExactComparisonRepository(git);
    const [file] = await comparisons.compare(root, base, target);
    expect(file).toMatchObject({ largeForReview: true, newBytes: 12582912, oldBytes: 12582912 });
    const nativeRun = runner.run.bind(runner);
    let transferredBytes = 0;
    runner.run = async input => {
      const result = await nativeRun(input);
      transferredBytes += result.stdout.byteLength;
      return result;
    };
    const request = { comparisonBaseOid: base, comparisonTargetOid: target, file };
    await expect(comparisons.readFile(root, request)).resolves.toEqual({ file, kind: 'large-text' });
    expect(transferredBytes).toBeLessThan(16 * 1024);
    await expect(comparisons.readFile(root, {
      ...request, file: { ...file, oldBytes: 1 },
    })).rejects.toMatchObject({
      code: 'authority-integrity-error', safeContext: { reason: 'review-blob-size-mismatch' },
    });
    await expect(comparisons.readFile(root, {
      ...request, file: { ...file, path: 'missing note.md' },
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });

  it.each([
    ['note.md', Buffer.from('new\n'), 'text', undefined],
    ['lines.md', Buffer.from('x\n'.repeat(50_000)), 'large-text', undefined],
    ['image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'binary', 'image/png'],
    ['spoofed.png', Buffer.from('<html>not an image</html>'), 'binary', undefined],
    ['invalid.md', Buffer.from([0xff, 0xfe]), 'binary', undefined],
  ] as const)('reads bounded content and classifies %s', async (filePath, contents, kind, mimeType) => {
    const base = await writeGitFixtureTree(runner, root, []);
    const target = await writeGitFixtureTree(runner, root, [{
      mode: '100644', oid: await writeGitFixtureBlob(runner, root, contents),
      path: filePath, type: 'blob',
    }]);
    const comparisons = new NativeGitExactComparisonRepository(git);
    const [file] = await comparisons.compare(root, base, target);
    const result = await comparisons.readFile(root, {
      comparisonBaseOid: base, comparisonTargetOid: target, file,
    });
    expect(result).toMatchObject({ kind, file: { newBytes: contents.byteLength, path: filePath } });
    const expected = kind === 'text'
      ? { file: result.file, kind, oldText: null, newText: 'new\n' }
      : { file: result.file, kind, ...(mimeType ? { preview: { bytes: contents, mimeType } } : {}) };
    expect(result).toEqual(expected);
  });

  it('cancels a running native comparison and settles its process before returning', async () => {
    const { base, target } = await fixture(32);
    const marker = path.join(root, 'comparison-started');
    const script = path.join(root, 'delayed-git.cjs');
    await writeFile(script, '#!/usr/bin/env node\n' + [
      "const { spawnSync } = require('node:child_process');",
      `const run = () => { const result = spawnSync(${JSON.stringify(executablePath)}, process.argv.slice(2), { stdio: 'inherit' }); process.exit(result.status ?? 1); };`,
      `if (process.argv[2] === 'diff-tree') { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setTimeout(run, 5000); } else run();`,
    ].join('\n'), { mode: 0o700 });
    let shim = script;
    if (process.platform === 'win32') {
      shim = path.join(root, 'delayed-git.cmd');
      await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`);
    }
    const delayedRunner = new GitCommandRunner({ emptyConfigPath, executablePath: shim });
    const comparisons = new NativeGitExactComparisonRepository(new GitRepositoryService(delayedRunner));
    const controller = new AbortController();
    const result = comparisons.compare(root, base, target, controller.signal)
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
  });
});
