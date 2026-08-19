import type { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';

const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface GitFixtureTreeEntry {
  readonly mode: '040000' | '100644' | '100755';
  readonly oid: string;
  readonly path: string;
  readonly type: 'blob' | 'tree';
}

function parseFixtureOid(output: Uint8Array): string {
  const oid = Buffer.from(output).toString('utf8').trim();
  if (!OID_PATTERN.test(oid)) {
    throw new Error('Git fixture command returned an invalid object ID');
  }
  return oid;
}

export async function writeGitFixtureBlob(
  runner: Pick<GitCommandRunner, 'run'>,
  repositoryPath: string,
  contents: Uint8Array,
): Promise<string> {
  const result = await runner.run({
    args: ['hash-object', '-w', '--stdin'],
    cwd: repositoryPath,
    stdin: contents,
  });
  return parseFixtureOid(result.stdout);
}

export async function writeGitFixtureTree(
  runner: Pick<GitCommandRunner, 'run'>,
  repositoryPath: string,
  entries: readonly GitFixtureTreeEntry[],
): Promise<string> {
  const stdin = [...entries]
    .sort((left, right) => (
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ))
    .map(entry => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.path}\u0000`)
    .join('');
  const result = await runner.run({
    args: ['mktree', '-z'],
    cwd: repositoryPath,
    stdin,
  });
  return parseFixtureOid(result.stdout);
}
