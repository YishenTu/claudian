import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  encodeKimiWorkDirKey,
  getTrustedKimiSessionRoots,
  resolveKimiHome,
  resolveKimiSessionDirectory,
  slugifyKimiWorkDirName,
} from '@/providers/kimi/history/KimiHistoryPathResolver';

describe('KimiHistoryPathResolver', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-history-path-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  });

  it('derives the bucket key as wd_<slug>_<sha256(normalized cwd)[:12]>', () => {
    // Known vector: sha256('/vault') starts with 27d33c883a0e.
    expect(encodeKimiWorkDirKey('/vault')).toBe('wd_vault_27d33c883a0e');

    const vaultPath = path.join(tempRoot, 'vault');
    const normalized = path.resolve(vaultPath);
    const expectedHash = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
    expect(encodeKimiWorkDirKey(vaultPath)).toBe(`wd_vault_${expectedHash}`);
    expect(encodeKimiWorkDirKey(vaultPath)).toBe(encodeKimiWorkDirKey(`${vaultPath}/`));
    expect(encodeKimiWorkDirKey(vaultPath)).not.toBe(encodeKimiWorkDirKey(`${vaultPath}-other`));
  });

  it('slugifies work dir names like agent-core', () => {
    expect(slugifyKimiWorkDirName('vault')).toBe('vault');
    expect(slugifyKimiWorkDirName('My Vault!')).toBe('my-vault');
    expect(slugifyKimiWorkDirName('--dash--')).toBe('dash');
    expect(slugifyKimiWorkDirName('dots_ok.txt')).toBe('dots_ok.txt');
    expect(slugifyKimiWorkDirName('')).toBe('workspace');
    expect(slugifyKimiWorkDirName('.')).toBe('workspace');
    expect(slugifyKimiWorkDirName('..')).toBe('workspace');
    expect(slugifyKimiWorkDirName('...')).toBe('...');
    expect(slugifyKimiWorkDirName('a'.repeat(60))).toBe('a'.repeat(40));
    // Slicing can re-expose trailing dashes, which are trimmed again.
    expect(slugifyKimiWorkDirName(`${'a'.repeat(39)}!${'b'.repeat(10)}`)).toBe('a'.repeat(39));
  });

  it('resolves the default home and the KIMI_CODE_HOME override', () => {
    expect(resolveKimiHome({ environment: { HOME: tempRoot } }))
      .toBe(path.resolve(tempRoot, '.kimi-code'));
    expect(resolveKimiHome({
      environment: { HOME: tempRoot, KIMI_CODE_HOME: '   ' },
    })).toBe(path.resolve(tempRoot, '.kimi-code'));

    const customHome = path.join(tempRoot, 'kimi-home');
    expect(resolveKimiHome({
      environment: { HOME: tempRoot, KIMI_CODE_HOME: customHome },
    })).toBe(path.resolve(customHome));
    expect(resolveKimiHome({
      environment: { HOME: tempRoot, KIMI_CODE_HOME: 'relative-home' },
    })).toBe(path.resolve(tempRoot, 'relative-home'));
    expect(getTrustedKimiSessionRoots({
      environment: { HOME: tempRoot, KIMI_CODE_HOME: customHome },
    })).toEqual([path.resolve(customHome, 'sessions')]);
  });

  it('resolves a session directly under the derived bucket directory', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session_00000000-0000-0000-0000-000000000001';
    const sessionDirectory = path.join(
      tempRoot,
      '.kimi-code',
      'sessions',
      encodeKimiWorkDirKey(vaultPath),
      sessionId,
    );
    fs.mkdirSync(sessionDirectory, { recursive: true });

    expect(resolveKimiSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { HOME: tempRoot },
    })).toBe(sessionDirectory);
  });

  it('never crosses from a configured home into the default home', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-collision';
    const customHome = path.join(tempRoot, 'kimi-home');
    const customDirectory = path.join(
      customHome,
      'sessions',
      encodeKimiWorkDirKey(vaultPath),
      sessionId,
    );
    const defaultDirectory = path.join(
      tempRoot,
      '.kimi-code',
      'sessions',
      encodeKimiWorkDirKey(vaultPath),
      sessionId,
    );
    fs.mkdirSync(customDirectory, { recursive: true });
    fs.mkdirSync(defaultDirectory, { recursive: true });
    const context = { environment: { HOME: tempRoot, KIMI_CODE_HOME: customHome } };

    expect(resolveKimiSessionDirectory(
      defaultDirectory,
      sessionId,
      vaultPath,
      context,
    )).toBe(customDirectory);

    fs.rmSync(customDirectory, { recursive: true });
    expect(resolveKimiSessionDirectory(
      defaultDirectory,
      sessionId,
      vaultPath,
      context,
    )).toBeNull();
  });

  it('accepts a trusted persisted hint whose basename matches the session id', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-hint';
    const hintDirectory = path.join(
      tempRoot,
      '.kimi-code',
      'sessions',
      encodeKimiWorkDirKey(vaultPath),
      sessionId,
    );
    fs.mkdirSync(hintDirectory, { recursive: true });

    expect(resolveKimiSessionDirectory(hintDirectory, sessionId, null, {
      environment: { HOME: tempRoot },
    })).toBe(path.resolve(hintDirectory));
  });

  it('repairs moved-vault paths through a bounded exact-id fallback scan', () => {
    const sessionId = 'session-moved';
    const movedDirectory = path.join(
      tempRoot,
      '.kimi-code',
      'sessions',
      encodeKimiWorkDirKey(path.join(tempRoot, 'old-vault')),
      sessionId,
    );
    fs.mkdirSync(movedDirectory, { recursive: true });

    expect(resolveKimiSessionDirectory(
      path.join(tempRoot, 'outside', sessionId),
      sessionId,
      path.join(tempRoot, 'new-vault'),
      { environment: { HOME: tempRoot } },
    )).toBe(movedDirectory);
  });

  it('rejects traversal, outside-root hints, and mismatched ids', () => {
    const sessionsRoot = path.join(tempRoot, '.kimi-code', 'sessions');
    const valid = path.join(sessionsRoot, encodeKimiWorkDirKey('/vault'), 'session-valid');
    fs.mkdirSync(valid, { recursive: true });
    const context = { environment: { HOME: tempRoot } };

    expect(resolveKimiSessionDirectory(
      path.join(tempRoot, 'outside', 'session-valid'),
      '../session-valid',
      '/vault',
      context,
    )).toBeNull();
    expect(resolveKimiSessionDirectory(null, 'session/../session-valid', '/vault', context))
      .toBeNull();
    expect(resolveKimiSessionDirectory(null, '', '/vault', context)).toBeNull();
    expect(resolveKimiSessionDirectory(null, null, '/vault', context)).toBeNull();

    // A hint outside the trusted root falls through to the direct/scan resolution.
    expect(resolveKimiSessionDirectory(
      path.join(tempRoot, 'outside', 'session-valid'),
      'session-valid',
      '/vault',
      context,
    )).toBe(valid);
    // A hint whose basename mismatches the session id is never trusted.
    expect(resolveKimiSessionDirectory(
      path.join(sessionsRoot, 'wd_other_000000000000', 'other-session'),
      'session-valid',
      null,
      context,
    )).toBe(valid);
  });

  it('returns null when no session directory exists anywhere trusted', () => {
    expect(resolveKimiSessionDirectory(undefined, 'missing-session', '/vault', {
      environment: { HOME: tempRoot },
    })).toBeNull();
  });
});
