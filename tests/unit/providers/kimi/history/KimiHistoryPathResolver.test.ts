import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  encodeKimiSessionCwd,
  getTrustedKimiSessionRoots,
  resolveKimiSessionDirectory,
  resolveKimiShareDir,
} from '@/providers/kimi/history/KimiHistoryPathResolver';

describe('KimiHistoryPathResolver', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-history-path-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  });

  it('encodes the session cwd as the md5 hex of the resolved absolute path', () => {
    const vaultPath = path.join(tempRoot, 'vault');

    expect(encodeKimiSessionCwd(vaultPath)).toMatch(/^[a-f0-9]{32}$/);
    expect(encodeKimiSessionCwd(vaultPath)).toBe(encodeKimiSessionCwd(`${vaultPath}/`));
    expect(encodeKimiSessionCwd(vaultPath)).not.toBe(encodeKimiSessionCwd(`${vaultPath}-other`));
  });

  it('resolves the default share dir and the KIMI_SHARE_DIR override', () => {
    expect(resolveKimiShareDir({ environment: { HOME: tempRoot } }))
      .toBe(path.resolve(tempRoot, '.kimi'));
    expect(resolveKimiShareDir({
      environment: { HOME: tempRoot, KIMI_SHARE_DIR: '   ' },
    })).toBe(path.resolve(tempRoot, '.kimi'));

    const customShare = path.join(tempRoot, 'kimi-share');
    expect(resolveKimiShareDir({
      environment: { HOME: tempRoot, KIMI_SHARE_DIR: customShare },
    })).toBe(path.resolve(customShare));
    expect(resolveKimiShareDir({
      environment: { HOME: tempRoot, KIMI_SHARE_DIR: 'relative-share' },
    })).toBe(path.resolve(tempRoot, 'relative-share'));
    expect(getTrustedKimiSessionRoots({
      environment: { HOME: tempRoot, KIMI_SHARE_DIR: customShare },
    })).toEqual([path.resolve(customShare, 'sessions')]);
  });

  it('resolves a session directly under the md5 cwd directory', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-default';
    const sessionDirectory = path.join(
      tempRoot,
      '.kimi',
      'sessions',
      encodeKimiSessionCwd(vaultPath),
      sessionId,
    );
    fs.mkdirSync(sessionDirectory, { recursive: true });

    expect(resolveKimiSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { HOME: tempRoot },
    })).toBe(sessionDirectory);
  });

  it('never crosses from a configured share dir into the default share dir', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-collision';
    const customShare = path.join(tempRoot, 'kimi-share');
    const customDirectory = path.join(
      customShare,
      'sessions',
      encodeKimiSessionCwd(vaultPath),
      sessionId,
    );
    const defaultDirectory = path.join(
      tempRoot,
      '.kimi',
      'sessions',
      encodeKimiSessionCwd(vaultPath),
      sessionId,
    );
    fs.mkdirSync(customDirectory, { recursive: true });
    fs.mkdirSync(defaultDirectory, { recursive: true });
    const context = { environment: { HOME: tempRoot, KIMI_SHARE_DIR: customShare } };

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
      '.kimi',
      'sessions',
      encodeKimiSessionCwd(vaultPath),
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
      '.kimi',
      'sessions',
      encodeKimiSessionCwd(path.join(tempRoot, 'old-vault')),
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
    const sessionsRoot = path.join(tempRoot, '.kimi', 'sessions');
    const valid = path.join(sessionsRoot, encodeKimiSessionCwd('/vault'), 'session-valid');
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
      path.join(sessionsRoot, 'other-cwd', 'other-session'),
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
