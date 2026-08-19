import {
  parseGitBatchBlob,
  parseGitBatchBlobSequence,
  parseGitBatchObjectMetadata,
  parseGitNameStatus,
  parseGitRawDiff,
  parseGitRecursiveTree,
  parseGitWorkingTreeState,
} from '@/app/collab/git/GitRepositoryService';

describe('GitRepositoryService parsers', () => {
  it('parses ordinary, rename, unmerged, and untracked porcelain v2 records', () => {
    const output = Buffer.from([
      '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb note with spaces.md',
      '2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 renamed.md',
      'old.md',
      'u UU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc conflict.md',
      '? new.md',
      '',
    ].join('\0'));

    expect(parseGitWorkingTreeState(output).entries).toEqual([
      {
        indexStatus: '.',
        kind: 'ordinary',
        path: 'note with spaces.md',
        worktreeStatus: 'M',
      },
      {
        indexStatus: 'R',
        kind: 'renamed',
        originalPath: 'old.md',
        path: 'renamed.md',
        worktreeStatus: '.',
      },
      {
        indexStatus: 'U',
        kind: 'unmerged',
        path: 'conflict.md',
        worktreeStatus: 'U',
      },
      {
        indexStatus: '?',
        kind: 'untracked',
        path: 'new.md',
        worktreeStatus: '?',
      },
    ]);
  });

  it('parses branch identity and divergence with working-tree status', () => {
    const oid = 'a'.repeat(40);
    const output = Buffer.from([
      `# branch.oid ${oid}`,
      '# branch.head members/member-a',
      '# branch.upstream origin/members/member-a',
      '# branch.ab +3 -2',
      '? notes/new note.md',
      '',
    ].join('\0'));

    expect(parseGitWorkingTreeState(output)).toEqual({
      branch: {
        aheadBy: 3,
        behindBy: 2,
        headName: 'members/member-a',
        headOid: oid,
        upstreamName: 'origin/members/member-a',
      },
      entries: [{
        indexStatus: '?',
        kind: 'untracked',
        path: 'notes/new note.md',
        worktreeStatus: '?',
      }],
    });
  });

  it('parses NUL name-status output without confusing rename paths', () => {
    const output = Buffer.from([
      'A', 'added.md',
      'M', 'modified.md',
      'D', 'deleted.md',
      'R095', 'old name.md', 'new name.md',
      '',
    ].join('\0'));

    expect(parseGitNameStatus(output)).toEqual([
      { kind: 'added', path: 'added.md' },
      { kind: 'modified', path: 'modified.md' },
      { kind: 'deleted', path: 'deleted.md' },
      { kind: 'renamed', path: 'new name.md', previousPath: 'old name.md' },
    ]);
  });

  it('parses full-index raw changes with exact old and new object ids', () => {
    const oldOid = 'a'.repeat(40);
    const newOid = 'b'.repeat(40);
    const zeroOid = '0'.repeat(40);
    const output = Buffer.from([
      `:000000 100644 ${zeroOid} ${newOid} A`, 'added.md',
      `:100644 000000 ${oldOid} ${zeroOid} D`, 'deleted.md',
      `:100644 100644 ${oldOid} ${newOid} M`, 'modified.md',
      `:100644 100644 ${oldOid} ${newOid} R095`, 'old name.md', 'new name.md',
      '',
    ].join('\0'));

    expect(parseGitRawDiff(output)).toEqual([
      { kind: 'added', newOid, path: 'added.md' },
      { kind: 'deleted', oldOid, path: 'deleted.md' },
      { kind: 'modified', newOid, oldOid, path: 'modified.md' },
      {
        kind: 'renamed',
        newOid,
        oldOid,
        path: 'new name.md',
        previousPath: 'old name.md',
      },
    ]);
  });

  it('parses ordered batch object metadata and rejects non-blob objects', () => {
    const first = 'a'.repeat(40);
    const second = 'b'.repeat(40);
    const missing = 'refs/heads/missing^{commit}';
    expect(parseGitBatchObjectMetadata(Buffer.from([
      `${first} blob 12`,
      `${second} commit 34`,
      `${missing} missing`,
      '',
    ].join('\n')), 3)).toEqual([
      { oid: first, size: 12, type: 'blob' },
      { oid: second, size: 34, type: 'commit' },
      null,
    ]);
    expect(() => parseGitBatchObjectMetadata(Buffer.from(`${first} malformed 1\n`), 1))
      .toThrow();
  });

  it('parses multiple binary-safe blobs from one cat-file batch response', () => {
    const firstOid = 'a'.repeat(40);
    const secondOid = 'b'.repeat(40);
    const first = Buffer.from([0x00, 0x0a, 0xff]);
    const second = Buffer.from('second\n');
    const output = Buffer.concat([
      Buffer.from(`${firstOid} blob ${first.length}\n`), first, Buffer.from('\n'),
      Buffer.from(`${secondOid} blob ${second.length}\n`), second, Buffer.from('\n'),
    ]);

    expect(parseGitBatchBlobSequence(output, 2)).toEqual([first, second]);
    expect(() => parseGitBatchBlobSequence(output, 1)).toThrow();
  });

  it('recognizes a missing batch blob whose requested path contains spaces', () => {
    const requestedObject = `${'a'.repeat(40)}:notes/path with spaces.md`;

    expect(parseGitBatchBlobSequence(
      Buffer.from(`${requestedObject} missing\n`),
      1,
    )).toEqual([null]);
  });

  it('rejects a malformed missing batch blob header', () => {
    expect(() => parseGitBatchBlobSequence(
      Buffer.from('garbage missing\n'),
      1,
    )).toThrow();
  });

  it('rejects malformed machine output instead of parsing localized prose', () => {
    expect(() => parseGitWorkingTreeState(Buffer.from('fatal: localized prose\0')).entries)
      .toThrow();
    expect(() => parseGitNameStatus(Buffer.from('R100\0missing-new-path\0')))
      .toThrow();
  });

  it('parses an exact binary blob from cat-file batch output', () => {
    const oid = 'a'.repeat(40);
    const contents = Buffer.from([0x00, 0x0a, 0xff, 0x20]);
    const output = Buffer.concat([
      Buffer.from(`${oid} blob ${contents.length}\n`),
      contents,
      Buffer.from('\n'),
    ]);

    expect(parseGitBatchBlob(output, oid)).toEqual(contents);
    expect(() => parseGitBatchBlob(Buffer.from(`${oid} tree 0\n\n`), oid)).toThrow();
    expect(() => parseGitBatchBlob(Buffer.from(`${oid} blob 2\na\n`), oid)).toThrow();
  });

  it('parses recursive tree metadata without interpreting file contents', () => {
    const blobOid = 'a'.repeat(40);
    const commitOid = 'b'.repeat(40);
    const output = Buffer.from([
      `100644 blob ${blobOid} 12\tnote with spaces.md`,
      `160000 commit ${commitOid} -\tnested-repository`,
      '',
    ].join('\0'));

    expect(parseGitRecursiveTree(output)).toEqual([
      {
        mode: '100644',
        oid: blobOid,
        path: 'note with spaces.md',
        size: 12,
        type: 'blob',
      },
      {
        mode: '160000',
        oid: commitOid,
        path: 'nested-repository',
        size: null,
        type: 'commit',
      },
    ]);
    expect(() => parseGitRecursiveTree(Buffer.from('localized prose\0'))).toThrow();
  });
});
