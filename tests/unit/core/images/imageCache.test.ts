import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { deleteCachedImages, ensureImageCacheDir, getCacheAbsolutePath,readCachedImageBase64, saveImageToCache } from '@/core/images/imageCache';
import type { ImageMediaType } from '@/core/types';

function createMockApp(vaultPath: string) {
  return {
    vault: {
      adapter: {
        basePath: vaultPath,
      },
    },
  } as any;
}

function createTempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-vault-'));
  return dir;
}

describe('imageCache', () => {
  let vaultPath: string;
  let app: any;

  beforeEach(() => {
    vaultPath = createTempVault();
    app = createMockApp(vaultPath);
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('creates cache directory and saves image with hash-based dedupe', () => {
    const buffer = Buffer.from('test-image');
    const mediaType: ImageMediaType = 'image/png';

    const dir = ensureImageCacheDir(app);
    expect(dir).toBe(path.join(vaultPath, '.claudian-cache', 'images'));

    const first = saveImageToCache(app, buffer, mediaType, 'pic.png');
    const second = saveImageToCache(app, buffer, mediaType, 'other.png');

    expect(first?.relPath).toBeDefined();
    expect(second?.relPath).toBe(first?.relPath);

    const absPath = path.join(vaultPath, first!.relPath);
    expect(fs.existsSync(absPath)).toBe(true);
    expect(fs.readFileSync(absPath).toString()).toBe('test-image');
  });

  it('reads cached image as base64', () => {
    const buffer = Buffer.from('another-image');
    const cache = saveImageToCache(app, buffer, 'image/jpeg', 'photo.jpg');
    expect(cache).not.toBeNull();

    const base64 = readCachedImageBase64(app, cache!.relPath);
    expect(base64).toBe(buffer.toString('base64'));
  });

  it('deletes cached images when requested', () => {
    const buffer = Buffer.from('delete-me');
    const cache = saveImageToCache(app, buffer, 'image/png', 'delete.png');
    const absPath = path.join(vaultPath, cache!.relPath);
    expect(fs.existsSync(absPath)).toBe(true);

    deleteCachedImages(app, [cache!.relPath]);
    expect(fs.existsSync(absPath)).toBe(false);
  });

  it('blocks cache path traversal outside cache root', () => {
    const abs = getCacheAbsolutePath(app, '.claudian-cache/images/../evil.png');
    expect(abs).toBeNull();
  });

  it('uses media type extension fallback when no preferred name', () => {
    const buffer = Buffer.from('jpeg-image');
    const cache = saveImageToCache(app, buffer, 'image/jpeg');
    expect(cache?.relPath.endsWith('.jpg')).toBe(true);
  });

  it('returns null when vault path is unavailable', () => {
    const noVaultApp = createMockApp('') as any;
    noVaultApp.vault.adapter = {};

    expect(ensureImageCacheDir(noVaultApp)).toBeNull();
    expect(saveImageToCache(noVaultApp, Buffer.from('x'), 'image/png')).toBeNull();
    expect(readCachedImageBase64(noVaultApp, '.claudian-cache/images/a.png')).toBeNull();
    expect(getCacheAbsolutePath(noVaultApp, '.claudian-cache/images/a.png')).toBeNull();
  });

  it('rejects invalid cache-relative paths', () => {
    expect(getCacheAbsolutePath(app, '/abs.png')).toBeNull();
    expect(getCacheAbsolutePath(app, 'other.png')).toBeNull();
  });
});
