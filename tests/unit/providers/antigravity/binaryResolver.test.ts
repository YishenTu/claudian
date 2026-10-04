import * as fs from 'fs';

import {
  AntigravityBinaryResolver,
  getPlatformDownloadUrl,
} from '@/providers/antigravity/runtime/AntigravityBinaryResolver';

describe('AntigravityBinaryResolver', () => {
  it('resolves auto-detected or existing binary path', () => {
    const resolver = new AntigravityBinaryResolver();
    const resolved = resolver.resolveFromSettings({});
    if (resolved) {
      expect(fs.existsSync(resolved)).toBe(true);
    }
  });

  it('provides platform download URLs for known platforms', () => {
    const url = getPlatformDownloadUrl();
    if (process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32') {
      expect(url).toBeDefined();
      expect(url).toMatch(/https:\/\/dl\.google\.com\//);
    }
  });
});
