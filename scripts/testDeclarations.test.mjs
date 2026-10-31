import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import declarations from './testDeclarations.cjs';

const { readTestDeclarations } = declarations;
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudian-test-declarations-'));
  const write = (file, source) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test('test registration follows a move, supports filesystem globs, and never executes test code', () => {
  const { root, write, cleanup } = fixture();
  try {
    write('src/style/components/panel.css', '');
    write('tests/fixtures/data.json', '{}');
    write('tests/unit/original.test.ts', `/** @vitest-environment jsdom */
// @test-ci {"native":true,"inputs":["src/style/**","tests/fixtures/{data,future}.json"]}
throw new Error('Do not execute test code during selection');
// @test-ci this is test body content, not a header declaration
`);
    write('tests/unit/unmarked.test.ts', "const example = '// @test-ci {invalid}';");
    mkdirSync(path.join(root, 'tests/integration'));
    renameSync(path.join(root, 'tests/unit/original.test.ts'), path.join(root, 'tests/integration/renamed.test.ts'));
    const index = readTestDeclarations(root);
    assert.deepEqual(index.crossPlatformTests, ['tests/integration/renamed.test.ts']);
    assert.deepEqual(index.fileConsumers, [
      ['src/style/**', ['tests/integration/renamed.test.ts']],
      ['tests/fixtures/{data,future}.json', ['tests/integration/renamed.test.ts']],
    ]);
  } finally { cleanup(); }
});

test('declarations parse from CRLF checkouts', () => {
  const { root, write, cleanup } = fixture();
  try {
    write('tests/fixtures/data.json', '{}');
    write('tests/unit/windows.test.ts', '// @test-ci {"native":true,"inputs":["tests/fixtures/data.json"]}\r\nexport {};\r\n');
    const index = readTestDeclarations(root);
    assert.deepEqual(index.crossPlatformTests, ['tests/unit/windows.test.ts']);
    assert.deepEqual(index.fileConsumers, [['tests/fixtures/data.json', ['tests/unit/windows.test.ts']]]);
  } finally { cleanup(); }
});

test('invalid, stale and misplaced declarations fail with file and line diagnostics', () => {
  const cases = [
    ['not JSON', 'invalid @test-ci JSON'],
    ['{"unknown":true}', 'accepts only native and inputs'],
    ['[]', 'accepts only native and inputs'],
    ['null', 'accepts only native and inputs'],
    ['{}', 'must declare native or inputs'],
    ['{"native":false}', 'native must be true'],
    ['{"inputs":"src/data.json"}', 'inputs must be a nonempty array'],
    ['{"inputs":[]}', 'inputs must be a nonempty array'],
    ['{"inputs":[3]}', 'repository-relative'],
    ['{"inputs":["../src/data.json"]}', 'repository-relative'],
    ['{"inputs":["src/../data.json"]}', 'repository-relative'],
    ['{"inputs":["src/data.json","src/data.json"]}', 'duplicate input'],
    ['{"inputs":["src/missing.json"]}', 'input matches no files'],
    ['{"inputs":["src/missing/**"]}', 'input matches no files'],
    ['{"inputs":["src/directory"]}', 'input matches no files'],
    ['{"native":true}\n// @test-ci {"native":true}', 'duplicate @test-ci declaration', 3],
  ];
  for (const [value, diagnostic, line = 2] of cases) {
    const { root, write, cleanup } = fixture();
    try {
      write('src/data.json', '{}');
      mkdirSync(path.join(root, 'src/directory'));
      write('tests/unit/invalid.test.ts', `// Header\n// @test-ci ${value}\n`);
      assert.throws(() => readTestDeclarations(root), error => {
        assert.ok(error.message.includes(`tests/unit/invalid.test.ts:${line}:`), error.message);
        assert.ok(error.message.includes(diagnostic), error.message);
        return true;
      }, value);
    } finally { cleanup(); }
  }
  const { root, write, cleanup } = fixture();
  try {
    write('tests/helpers/Misplaced.ts', '// @test-ci {"native":true}\n');
    assert.throws(() => readTestDeclarations(root, { validateNonTests: true }),
      /tests\/helpers\/Misplaced\.ts:1: @test-ci is only allowed/);
  } finally { cleanup(); }
});

test('repository declarations are valid, including support-file placement', () => {
  readTestDeclarations(path.resolve(import.meta.dirname, '..'), { validateNonTests: true });
});
