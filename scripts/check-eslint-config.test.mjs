import assert from 'node:assert/strict';
import test from 'node:test';

import { ESLint } from 'eslint';

import { fileNamingRule } from '../eslint.config.mjs';

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
  assert.deepEqual(config.rules['eslint-comments/no-restricted-disable'], [
    2,
    'obsidianmd/*',
  ]);
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
    'OpencodeSqliteReader.ts', 'ManagedStdioProcess.ts', 'windowsCmdShim.ts',
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
