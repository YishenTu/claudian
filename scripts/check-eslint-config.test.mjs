import assert from 'node:assert/strict';
import test from 'node:test';

import { ESLint } from 'eslint';

import { fileNamingRule } from '../eslint.config.mjs';
import packageJson from '../package.json' with { type: 'json' };

for (const [name, code, rule] of [
  ['unused short-circuit expression', 'export function run(enabled: boolean, action: () => void): void { enabled && action(); }', '@typescript-eslint/no-unused-expressions'],
  ['eval', 'export function run(code: string) { return eval(code); }', 'no-eval'],
  ['unsafe HTML', 'export function render(text: string) { document.body.innerHTML = text; }', 'no-unsanitized/property'],
  ['unknown string conversion', 'export function label(value: object) { return String(value); }', '@typescript-eslint/no-base-to-string'],
  ['unknown interpolation', 'export function label(value: unknown) { return `${value}`; }', '@typescript-eslint/restrict-template-expressions'],
]) {
  test(`official source lint rejects ${name}`, async () => {
    // Each snippet replaces the same on-disk file. CI's single-run optimization
    // reads that file first, then uses isolated programs without full type information.
    const eslint = new ESLint({
      overrideConfig: {
        languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
      },
    });
    const [result] = await eslint.lintText(code, { filePath: 'src/utils/error.ts' });
    assert.ok(result.messages.some(message => message.ruleId === rule), JSON.stringify(result.messages));
  });
}

test('metadata lint checks manifest structure and disallowed dependencies', async () => {
  const eslint = new ESLint();
  for (const [filePath, code, rule] of [
    ['manifest.json', '{ "name": "Claudian" }', 'obsidianmd/validate-manifest'],
    ['package.json', '{ "dependencies": { "left-pad": "1.3.0" } }', 'depend/ban-dependencies'],
  ]) {
    assert.ok(packageJson.scripts.lint.includes(filePath));
    const [result] = await eslint.lintText(code, { filePath });
    assert.ok(result.messages.some(message => message.ruleId === rule), JSON.stringify(result.messages));
  }
});

test('Obsidian DOM creation helpers are enforced for source files', async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile('src/utils/fileLink.ts');

  assert.deepEqual(config.rules['obsidianmd/prefer-create-el'], [2]);
});

test('TypeScript promise rejections require Error reasons with type information', async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile(
    'src/features/chat/execution/ChatExecutionCoordinator.ts',
  );

  assert.equal(config.rules['prefer-promise-reject-errors'][0], 0);
  assert.equal(config.rules['@typescript-eslint/prefer-promise-reject-errors'][0], 2);
});

test('source lint matches strict Obsidian and type-aware review policy', async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile(
    'src/features/chat/ClaudianView.ts',
  );

  for (const rule of [
    '@typescript-eslint/await-thenable',
    '@typescript-eslint/no-deprecated',
    '@typescript-eslint/no-redundant-type-constituents',
    '@typescript-eslint/no-unsafe-call',
    '@typescript-eslint/no-unsafe-member-access',
    '@typescript-eslint/prefer-promise-reject-errors',
    'eslint-comments/require-description',
    'obsidianmd/detach-leaves',
    'obsidianmd/hardcoded-config-path',
    'obsidianmd/settings-tab/no-deprecated-display',
  ]) {
    assert.equal(config.rules[rule]?.[0], 2, `${rule} must be an error`);
  }
  const restrictedDisables = config.rules['eslint-comments/no-restricted-disable'];
  assert.equal(restrictedDisables[0], 2);
  for (const rule of ['obsidianmd/*', 'no-eval', 'no-console']) {
    assert.ok(restrictedDisables.includes(rule), `${rule} must not be suppressed`);
  }
});

// ESLint hands the rule an absolute path using the host platform's separator, so the
// basename has to be taken from either separator. Windows paths are used here on every
// platform on purpose: they are what regressed, and CI only runs Linux.
function reportsFor(physicalFilename, body = []) {
  const reported = [];
  const visitor = fileNamingRule.create({
    physicalFilename,
    report: descriptor => reported.push(descriptor),
  });
  visitor.Program?.({ body });

  return reported;
}

test('file naming reads the basename from either path separator', () => {
  assert.deepEqual(reportsFor('/repo/src/utils/fileLink.ts'), []);
  assert.deepEqual(reportsFor('D:\\repo\\src\\utils\\fileLink.ts'), []);
});

test('file naming still rejects an invalid basename behind a Windows path', () => {
  const reported = reportsFor('D:\\repo\\src\\utils\\some_snake_case.ts');

  assert.equal(reported.length, 1);
  assert.equal(reported[0].messageId, 'invalidCase');
  assert.equal(reported[0].data.name, 'some_snake_case.ts');
});


test('file naming preserves acronym capitals at word boundaries', () => {
  for (const [name, expected] of [
    ['AcpClientConnection.ts', 'ACPClientConnection.ts'],
    ['HttpsClient.ts', 'HTTPSClient.ts'],
    ['SessionIds.ts', 'SessionIDs.ts'],
    ['buildAcpUsageInfo.test.ts', 'buildACPUsageInfo.test.ts'],
    ['AcpJsonRpcTransport.ts', 'ACPJSONRPCTransport.ts'],
    ['CloudAuthorityUrls.ts', 'CloudAuthorityURLs.ts'],
    ['PiExtensionUiBridge.dom.test.ts', 'PiExtensionUIBridge.dom.test.ts'],
    ['loadClaudeAgentSdk.ts', 'loadClaudeAgentSDK.ts'],
  ]) {
    for (const prefix of ['/repo/src/', 'D:\\repo\\src\\']) {
      const reports = reportsFor(prefix + name);
      assert.equal(reports.length, 1, name);
      assert.equal(reports[0].messageId, 'acronymCase');
      assert.equal(reports[0].data.expected, expected);
    }
  }
});

test('file naming accepts acronym conventions and non-acronym words', () => {
  for (const name of [
    'ACPClientConnection.ts', 'ACPJSONRPCTransport.ts', 'buildACPUsageInfo.test.ts',
    'CloudAuthorityURLs.ts', 'SQLJSSnapshotStore.ts', 'LANTLSIdentity.ts',
    'cliBinaryLocator.ts', 'acpConnection.ts', 'sdkMessages.ts', 'urlParser.ts',
    'PiExtensionUIBridge.dom.test.ts', 'api-client.ts', 'index.ts', 'types.ts',
    'SqliteReader.ts', 'ManagedStdioProcess.ts', 'windowsCmdShim.ts',
    'NoopTaskResultInterpreter.ts', 'SQLWasmAsset.ts', 'Client.ts', 'Clipboard.ts',
  ]) assert.deepEqual(reportsFor('/repo/src/' + name), [], name);
});

test('file naming matches a leading camelCase acronym to its exported concept', () => {
  const reports = reportsFor('/repo/src/acpConnection.ts', [{
    type: 'ExportNamedDeclaration',
    declaration: { type: 'ClassDeclaration', id: { type: 'Identifier', name: 'ACPConnection' } },
  }]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].messageId, 'conceptMismatch');
  assert.equal(reports[0].data.concept, 'ACPConnection');
});

test('the shared clock rejects fixed calendar anchors', async () => {
  const eslint = new ESLint();
  for (const filePath of ['tests/helpers/testClock.ts']) {
    for (const code of [
      "const anchor = '2026-08-27T00:00:00.000Z'; void anchor;",
      "const query = `SELECT '2026-08-27T00:00:00.000Z'`; void query;",
      'const date = `2026-08-27T00:${minute}:00.000Z`; void date;',
      'const anchor = new Date(2026, 7, 27); void anchor;',
      'const anchor = Date.UTC(2026, 7, 27); void anchor;',
    ]) {
      const [result] = await eslint.lintText(code, { filePath });
      assert.ok(result.messages.some(message => message.ruleId === 'no-restricted-syntax'), filePath);
    }
  }
});


test('test lint retains alias, callback, focused-test and suite-export checks', async () => {
  const eslint = new ESLint();
  for (const [code, rule] of [
    ["test('alias', () => { expect(vi.fn()).toBeCalled(); });", 'vitest/no-alias-methods'],
    ["test('callback', done => { expect(true).toBe(true); done(); });", 'vitest/no-done-callback'],
    ["test.only('focused', () => { expect(true).toBe(true); });", 'vitest/no-focused-tests'],
    ["export const value = 1; test('export', () => { expect(value).toBe(1); });", 'no-restricted-syntax'],
  ]) {
    const [result] = await eslint.lintText(code, { filePath: 'tests/unit/utils/example.test.ts' });
    assert.ok(result.messages.some(message => message.ruleId === rule), JSON.stringify(result.messages));
  }
});

test('test imports require declared packages, including Vitest factory imports', async () => {
  const eslint = new ESLint();
  const filePath = 'tests/helpers/dependencyProbe.ts';
  const rule = 'local/declared-test-dependencies';
  for (const code of [
    "import value from 'js-yaml'; void value;",
    "export { value } from '@undeclared/package/subpath';",
    "export * from 'js-yaml';",
    "void import('js-yaml');",
    "void require('js-yaml');",
    "void vi.importActual('js-yaml');",
    "void vi.importMock('js-yaml');",
    "vi.mock('js-yaml', async () => await vi.importActual('js-yaml'));",
  ]) {
    const [result] = await eslint.lintText(code, { filePath });
    assert.ok(result.messages.some(message => message.ruleId === rule), code);
  }
  for (const code of [
    "import { parse } from 'yaml'; void parse;",
    "void import('@modelcontextprotocol/sdk/types.js');",
    "void vi.importActual('obsidian');",
    "void import('node:fs/promises'); void require('fs');",
    "void import('@/utils/error'); void import('@test/helpers/testClock');",
    "void import('./fixture'); void import('../fixture');",
  ]) {
    const [result] = await eslint.lintText(code, { filePath });
    assert.equal(result.messages.filter(message => message.ruleId === rule).length, 0, code);
  }
});

test('tests use the shared Obsidian fake and seeded installation key instead of per-file module mocks', async () => {
  const eslint = new ESLint();
  const filePaths = [
    'tests/unit/utils/example.test.ts',
    'tests/integration/app/example.test.ts',
    'tests/helpers/example.ts',
  ];
  const restricted = ['obsidian', '@/core/device/InstallationKey'].flatMap(source =>
    ['vi', 'vitest'].flatMap(api => ['mock', 'doMock'].flatMap(method => [
      `${api}.${method}('${source}', () => ({}));`,
      `${api}.${method}(import('${source}'), () => ({}));`,
    ])));
  for (const filePath of filePaths) {
    for (const code of restricted) {
      const [result] = await eslint.lintText(code, { filePath });
      assert.ok(result.messages.some(message => message.ruleId === 'no-restricted-syntax'), `${filePath}: ${code}`);
    }
    for (const code of [
      "vi.mock('node:fs', () => ({}));",
      "vi.spyOn(app.vault, 'read').mockRejectedValueOnce(new Error('Disk unavailable'));",
      "void vi.importActual('obsidian');",
    ]) {
      const [result] = await eslint.lintText(code, { filePath });
      assert.equal(result.messages.filter(message => message.ruleId === 'no-restricted-syntax').length, 0, `${filePath}: ${code}`);
    }
  }
});
