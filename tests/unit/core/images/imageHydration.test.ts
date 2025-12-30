import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { saveImageToCache } from '@/core/images/imageCache';
import { hydrateImagesData } from '@/core/images/imageLoader';
import type { ImageAttachment } from '@/core/types';

function createMockPlugin(vaultPath: string) {
  return {
    settings: {
      enableBlocklist: true,
      blockedCommands: { unix: [], windows: [] },
      showToolUse: true,
      permissions: [],
      permissionMode: 'yolo',
      model: 'haiku',
      thinkingBudget: 'off',
      mediaFolder: '',
    },
    app: {
      vault: {
        adapter: {
          basePath: vaultPath,
        },
      },
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
  } as any;
}

function createTempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-vault-'));
  return dir;
}

describe('ClaudianService image hydration', () => {
  let vaultPath: string;
  let plugin: any;

  beforeEach(() => {
    vaultPath = createTempVault();
    plugin = createMockPlugin(vaultPath);
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('hydrates base64 from cachePath', async () => {
    const buffer = Buffer.from('cached-image');
    const cache = saveImageToCache(plugin.app, buffer, 'image/png', 'cached.png');

    const images: ImageAttachment[] = [{
      id: 'img-1',
      name: 'cached.png',
      mediaType: 'image/png',
      size: buffer.length,
      cachePath: cache!.relPath,
      source: 'paste',
    }];

    const hydrated = await hydrateImagesData(plugin.app, images, vaultPath);
    expect(hydrated).toBeDefined();
    expect(hydrated![0].data).toBe(buffer.toString('base64'));
  });

  it('hydrates base64 from filePath when cache missing', async () => {
    const imgPath = path.join(vaultPath, 'images', 'photo.jpg');
    fs.mkdirSync(path.dirname(imgPath), { recursive: true });
    const buffer = Buffer.from('file-image');
    fs.writeFileSync(imgPath, buffer);

    const images: ImageAttachment[] = [{
      id: 'img-2',
      name: 'photo.jpg',
      mediaType: 'image/jpeg',
      size: buffer.length,
      filePath: 'images/photo.jpg',
      source: 'file',
    }];

    const hydrated = await hydrateImagesData(plugin.app, images, vaultPath);
    expect(hydrated).toBeDefined();
    expect(hydrated![0].data).toBe(buffer.toString('base64'));
  });

  it('returns undefined when no sources are available', async () => {
    const images: ImageAttachment[] = [{
      id: 'img-3',
      name: 'missing.png',
      mediaType: 'image/png',
      size: 1,
      cachePath: '.claudian-cache/images/missing.png',
      filePath: 'missing.png',
      source: 'paste',
    }];

    const hydrated = await hydrateImagesData(plugin.app, images, vaultPath);
    expect(hydrated).toBeUndefined();
  });
});
