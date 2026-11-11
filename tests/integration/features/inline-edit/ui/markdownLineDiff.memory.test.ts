// @test-ci {"native":true,"inputs":["src/features/inline-edit/ui/markdownLineDiff.ts"]}
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const runNode = promisify(execFile);

it('builds exact preview documents for a rewritten 5,000-line selection within a 128 MiB V8 heap', async () => {
  const source = pathToFileURL(resolve('src/features/inline-edit/ui/markdownLineDiff.ts')).href;
  const program = `
    import assert from 'node:assert/strict';
    const { computeMarkdownDiff, buildMarkdownDiffDocuments, countDiffLines } = await import(process.argv[1]);
    const before = Array.from({ length: 5000 }, (_, index) => 'Old paragraph ' + index + '\\n').join('');
    const after = Array.from({ length: 5000 }, (_, index) => 'New paragraph ' + index + '\\n').join('');
    const operations = computeMarkdownDiff(before, after);
    assert.deepEqual(buildMarkdownDiffDocuments(operations), [
      { type: 'delete', markdown: before }, { type: 'insert', markdown: after },
    ]);
    assert.equal(countDiffLines(operations, 'delete'), 5000);
    assert.equal(countDiffLines(operations, 'insert'), 5000);
    process.stdout.write('Exact preview documents and line counts preserved');
  `;
  const { stdout } = await runNode(process.execPath, [
    '--max-old-space-size=128', '--experimental-strip-types', '--input-type=module', '--eval', program, source,
  ], { timeout: 30_000, maxBuffer: 128 * 1024 });
  expect(stdout).toBe('Exact preview documents and line counts preserved');
}, 35_000);
