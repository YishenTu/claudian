import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AntigravityBinaryResolver,
  getPlatformDownloadUrl,
} from '@/providers/antigravity/runtime/AntigravityBinaryResolver';

describe('AntigravityBinaryResolver', () => {
  it('resolves configured binary path when specified', () => {
    const resolver = new AntigravityBinaryResolver();
    const tmpBinary = path.join(os.tmpdir(), `test-binary-${Date.now()}`);
    fs.writeFileSync(tmpBinary, '#!/bin/sh\n');
    try {
      const resolved = resolver.resolveFromSettings({
        providerConfigs: {
          antigravity: {
            cliPath: tmpBinary,
          },
        },
      });
      expect(resolved).toBe(tmpBinary);
    } finally {
      if (fs.existsSync(tmpBinary)) {
        fs.unlinkSync(tmpBinary);
      }
    }
  });

  it('handles empty settings gracefully', () => {
    const resolver = new AntigravityBinaryResolver();
    const resolved = resolver.resolveFromSettings({});
    const isValid = resolved === null || (typeof resolved === 'string' && fs.existsSync(resolved));
    expect(isValid).toBe(true);
  });

  it('provides platform download URLs for known platforms', () => {
    const url = getPlatformDownloadUrl();
    const isKnownPlatform = ['linux', 'darwin', 'win32'].includes(process.platform);
    const isValid = url ? url.startsWith('https://dl.google.com/') : !isKnownPlatform;
    expect(isValid).toBe(true);
  });
});
