import * as crypto from 'crypto';

import { cursorWorkspaceHash } from '@/providers/cursor/history/cursorHistoryStore';

describe('cursorHistoryStore', () => {
  it('hashes workspace path with md5 hex like Cursor CLI', () => {
    const vaultPath = '/tmp/claudian-test-vault-path';
    expect(cursorWorkspaceHash(vaultPath)).toBe(
      crypto.createHash('md5').update(vaultPath).digest('hex'),
    );
  });
});
