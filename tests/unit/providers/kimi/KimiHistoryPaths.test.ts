import * as crypto from 'node:crypto';
import * as path from 'node:path';

import {
  encodeKimiWorkDirKey,
  resolveKimiHistoryFile,
} from '@/providers/kimi/history/KimiHistoryPaths';

describe('encodeKimiWorkDirKey', () => {
  it('matches Kimi agent-core basename slug and normalized-path hash', () => {
    const vaultPath = path.resolve('/tmp/My Study Vault');
    const hash = crypto.createHash('sha256').update(vaultPath).digest('hex').slice(0, 12);

    expect(encodeKimiWorkDirKey(vaultPath)).toBe(`wd_my-study-vault_${hash}`);
  });

  it('normalizes Windows-shaped paths independent of the current host OS', () => {
    const normalized = 'C:/Users/Eone/My Vault';
    const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);

    expect(encodeKimiWorkDirKey('C:\\Users\\Eone\\My Vault')).toBe(
      `wd_my-vault_${hash}`,
    );
  });
});

describe('resolveKimiHistoryFile', () => {
  it('rejects path traversal in persisted session ids', () => {
    expect(resolveKimiHistoryFile('/vault', '../../credentials', {
      kimiCodeHome: '/tmp/kimi-home',
    })).toBeNull();
    expect(resolveKimiHistoryFile('/vault', '..\\..\\credentials', {
      kimiCodeHome: '/tmp/kimi-home',
    })).toBeNull();
  });
});
