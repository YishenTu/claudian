#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'packages', 'collab-protocol');
const snapshotRelativePath = 'packages/collab-protocol/contract-snapshot.json';
const snapshotPath = path.join(root, snapshotRelativePath);
const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');
const ts = require('typescript');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match) throw new Error(`Invalid package SemVer in protocol snapshot: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] > right[field] ? 1 : -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease.localeCompare(right.prerelease, 'en-US');
}

export function digestTypeScriptBehavior(source) {
  const normalized = transformSync(source.replace(/\r\n/gu, '\n'), {
    format: 'esm',
    legalComments: 'none',
    loader: 'ts',
    minifyIdentifiers: false,
    minifySyntax: false,
    minifyWhitespace: true,
    target: 'es2022',
  }).code;
  return createHash('sha256').update(normalized).digest('hex');
}

function declaredNames(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map(declaration => ts.isIdentifier(declaration.name) ? declaration.name.text : null)
      .filter(Boolean);
  }
  if (
    ts.isClassDeclaration(statement)
    || ts.isEnumDeclaration(statement)
    || ts.isFunctionDeclaration(statement)
    || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement)
  ) {
    return statement.name ? [statement.name.text] : [];
  }
  return [];
}

function publicDeclarations() {
  const distRoot = path.join(packageRoot, 'dist');
  if (!existsSync(distRoot)) {
    throw new Error('Collab protocol dist is missing; run npm run build:protocol first.');
  }
  const indexPath = path.join(distRoot, 'index.d.ts');
  const indexSource = ts.createSourceFile(
    indexPath,
    readFileSync(indexPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = [];
  for (const statement of indexSource.statements) {
    if (
      !ts.isExportDeclaration(statement)
      || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text;
    const declarationPath = path.join(distRoot, `${moduleName.replace(/^\.\//u, '')}.d.ts`);
    const declarationSource = ts.createSourceFile(
      declarationPath,
      readFileSync(declarationPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const element of statement.exportClause.elements) {
      const localName = element.propertyName?.text ?? element.name.text;
      const matches = declarationSource.statements.filter(item => (
        declaredNames(item).includes(localName)
      ));
      if (matches.length === 0) {
        throw new Error(`Cannot resolve public protocol declaration ${localName} from ${moduleName}`);
      }
      declarations.push({
        declaration: matches
          .map(item => item.getText(declarationSource).replace(/\r\n/gu, '\n'))
          .join('\n'),
        exportName: element.name.text,
        source: moduleName,
      });
    }
  }
  return declarations.sort((left, right) => left.exportName.localeCompare(right.exportName, 'en-US'));
}

function decoderBehaviorDigests() {
  return [
    'CollabCloudBinding.ts',
    'CollabCloudProjectEvent.ts',
    'CollabCloudProjectSnapshot.ts',
    'CollabControlOperationCodecs.ts',
    'CollabProtocol.ts',
    'CollabRequestTicketRequestCodecs.ts',
    'CollabRequestTicketResponseCodecs.ts',
    'CollabValidation.ts',
    'DevelopmentBootstrap.ts',
  ].map(name => {
    const contents = readFileSync(path.join(packageRoot, 'src', name), 'utf8');
    return {
      path: `src/${name}`,
      sha256: digestTypeScriptBehavior(contents),
    };
  });
}

export function generateProtocolContractSnapshot() {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const entryPath = path.join(packageRoot, 'dist', 'index.js');
  delete require.cache[require.resolve(entryPath)];
  const protocol = require(entryPath);
  return stableValue({
    contract: {
      decoderBehaviorDigests: decoderBehaviorDigests(),
      errorCodes: [...protocol.COLLAB_ERROR_CODES],
      exports: stableValue(manifest.exports),
      gitRefs: {
        main: protocol.COLLAB_MAIN_REF,
        memberPrefix: protocol.COLLAB_MEMBER_REF_PREFIX,
      },
      limits: stableValue(protocol.COLLAB_LIMITS),
      operations: Object.keys(protocol.COLLAB_CONTROL_OPERATION_CODECS).sort(),
      publicDeclarations: publicDeclarations(),
      publicRuntimeExports: Object.keys(protocol).sort(),
    },
    packageVersion: manifest.version,
    protocolVersion: protocol.COLLAB_PROTOCOL_VERSION,
    schemaVersion: 1,
  });
}

export function snapshotsHaveEqualContract(left, right) {
  return stableJson(left.contract) === stableJson(right.contract);
}

export function assertVersionedContractChange(base, current) {
  const failures = [];
  const packageComparison = compareSemver(current.packageVersion, base.packageVersion);
  const protocolComparison = current.protocolVersion - base.protocolVersion;
  if (packageComparison < 0) failures.push('package version cannot decrease');
  if (protocolComparison < 0) failures.push('wire protocol version cannot decrease');
  if (!snapshotsHaveEqualContract(base, current)) {
    if (packageComparison <= 0) failures.push('package version must increase for a contract change');
    else {
      const baseVersion = parseSemver(base.packageVersion);
      const currentVersion = parseSemver(current.packageVersion);
      const minorOrGreater = currentVersion.major > baseVersion.major
        || (currentVersion.major === baseVersion.major && currentVersion.minor > baseVersion.minor);
      if (!minorOrGreater) {
        failures.push('package version must increase by at least a minor release for a contract change');
      }
    }
    if (protocolComparison <= 0) {
      failures.push('wire protocol version must increase for a contract change');
    }
  }
  if (failures.length > 0) {
    throw new Error(`Collab protocol compatibility check failed: ${failures.join('; ')}`);
  }
}

const GIT_SHOW_MISSING_PATH = /(?:does not exist in|exists on disk, but not in)/u;

export function readBaseSnapshot(baseSha, { cwd = root } = {}) {
  if (!/^[0-9a-f]{7,40}$/iu.test(baseSha)) {
    throw new Error(`Invalid base commit for protocol compatibility check: ${baseSha}`);
  }
  let shown;
  try {
    execFileSync(
      'git',
      ['cat-file', '-e', `${baseSha}^{commit}`],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `Cannot read the base protocol contract snapshot at ${baseSha}: ${stderr || 'base commit unavailable'}`,
    );
  }
  try {
    shown = execFileSync(
      'git',
      ['show', `${baseSha}:${snapshotRelativePath}`],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    if (GIT_SHOW_MISSING_PATH.test(stderr)) return null;
    throw new Error(
      `Cannot read the base protocol contract snapshot at ${baseSha}: ${stderr.trim() || 'git show failed'}`,
    );
  }
  try {
    return JSON.parse(shown);
  } catch (error) {
    throw new Error(
      `Cannot parse the base protocol contract snapshot at ${baseSha}: ${error.message}`,
    );
  }
}

function run() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const baseIndex = args.indexOf('--base');
  const baseSha = baseIndex >= 0 ? args[baseIndex + 1] : null;
  if (baseIndex >= 0 && !baseSha) throw new Error('--base requires a commit SHA');

  const generated = generateProtocolContractSnapshot();
  if (write) {
    writeFileSync(snapshotPath, `${JSON.stringify(generated, null, 2)}\n`);
    console.log(`Updated ${snapshotRelativePath}`);
    return;
  }
  if (!existsSync(snapshotPath)) {
    throw new Error(`Missing ${snapshotRelativePath}; run npm run check:protocol-compatibility -- --write.`);
  }
  const committed = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  if (stableJson(generated) !== stableJson(committed)) {
    throw new Error(
      `Collab protocol contract snapshot is stale; run npm run check:protocol-compatibility -- --write and review the version policy.`,
    );
  }
  if (baseSha) {
    const base = readBaseSnapshot(baseSha);
    if (base) assertVersionedContractChange(base, committed);
    else console.log('Base commit has no protocol contract snapshot; treating this change as bootstrap.');
  }
  console.log('Collab protocol compatibility: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
