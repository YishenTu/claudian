import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  encodeGrokSessionCwd,
  resolveGrokSessionDirectory,
} from '@/providers/grok/history/GrokHistoryPathResolver';

describe('GrokHistoryPathResolver', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-history-path-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  });

  it('resolves default and custom homes using the percent-encoded cwd', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-default';
    const defaultDirectory = path.join(
      tempRoot,
      '.grok',
      'sessions',
      encodeGrokSessionCwd(vaultPath),
      sessionId,
    );
    fs.mkdirSync(defaultDirectory, { recursive: true });

    expect(resolveGrokSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { HOME: tempRoot },
    })).toBe(defaultDirectory);

    const customHome = path.join(tempRoot, 'custom-grok');
    const customDirectory = path.join(
      customHome,
      'sessions',
      encodeGrokSessionCwd(vaultPath),
      'session-custom',
    );
    fs.mkdirSync(customDirectory, { recursive: true });
    expect(resolveGrokSessionDirectory(undefined, 'session-custom', vaultPath, {
      environment: { GROK_HOME: customHome, HOME: tempRoot },
    })).toBe(customDirectory);
  });

  it('never crosses from a configured home into the default home', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-collision';
    const customHome = path.join(tempRoot, 'custom-grok');
    const customDirectory = path.join(
      customHome,
      'sessions',
      encodeGrokSessionCwd(vaultPath),
      sessionId,
    );
    const defaultDirectory = path.join(
      tempRoot,
      '.grok',
      'sessions',
      '%2Fprevious%2Fvault',
      sessionId,
    );
    fs.mkdirSync(customDirectory, { recursive: true });
    fs.mkdirSync(defaultDirectory, { recursive: true });
    const context = { environment: { GROK_HOME: customHome, HOME: tempRoot } };

    expect(resolveGrokSessionDirectory(
      defaultDirectory,
      sessionId,
      vaultPath,
      context,
    )).toBe(customDirectory);

    fs.rmSync(customDirectory, { recursive: true });
    expect(resolveGrokSessionDirectory(
      defaultDirectory,
      sessionId,
      vaultPath,
      context,
    )).toBeNull();
  });

  it('uses the default home only when GROK_HOME is absent or blank', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-default-fallback';
    const defaultDirectory = path.join(
      tempRoot,
      '.grok',
      'sessions',
      encodeGrokSessionCwd(vaultPath),
      sessionId,
    );
    fs.mkdirSync(defaultDirectory, { recursive: true });

    expect(resolveGrokSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { HOME: tempRoot },
    })).toBe(defaultDirectory);
    expect(resolveGrokSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { GROK_HOME: '   ', HOME: tempRoot },
    })).toBe(defaultDirectory);
    expect(resolveGrokSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { GROK_HOME: 'relative-grok-home', HOME: tempRoot },
    })).toBeNull();
  });

  it('repairs moved-vault paths through a bounded exact-id fallback', () => {
    const sessionId = 'session-moved';
    const movedDirectory = path.join(
      tempRoot,
      '.grok',
      'sessions',
      '%2Fold%2Fvault',
      sessionId,
    );
    fs.mkdirSync(movedDirectory, { recursive: true });

    expect(resolveGrokSessionDirectory(
      path.join(tempRoot, 'outside', sessionId),
      sessionId,
      path.join(tempRoot, 'new-vault'),
      { environment: { HOME: tempRoot } },
    )).toBe(movedDirectory);
  });

  it('rejects traversal, outside-root hints, and mismatched ids', () => {
    const sessionsRoot = path.join(tempRoot, '.grok', 'sessions');
    const valid = path.join(sessionsRoot, '%2Fvault', 'session-valid');
    fs.mkdirSync(valid, { recursive: true });

    expect(resolveGrokSessionDirectory(
      path.join(tempRoot, 'outside', 'session-valid'),
      '../session-valid',
      '/vault',
      { environment: { HOME: tempRoot } },
    )).toBeNull();
    expect(resolveGrokSessionDirectory(
      path.join(sessionsRoot, '%2Fvault', 'other-session'),
      'session-valid',
      '/missing-vault',
      { environment: { HOME: tempRoot } },
    )).toBe(valid);
  });

  it('rejects a session directory symlink that escapes the effective home', () => {
    if (process.platform === 'win32') return;

    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-symlink';
    const customHome = path.join(tempRoot, 'custom-grok');
    const cwdDirectory = path.join(
      customHome,
      'sessions',
      encodeGrokSessionCwd(vaultPath),
    );
    const outsideDirectory = path.join(tempRoot, 'outside', sessionId);
    fs.mkdirSync(cwdDirectory, { recursive: true });
    fs.mkdirSync(outsideDirectory, { recursive: true });
    fs.symlinkSync(outsideDirectory, path.join(cwdDirectory, sessionId), 'dir');

    expect(resolveGrokSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { GROK_HOME: customHome, HOME: tempRoot },
    })).toBeNull();
  });
});
