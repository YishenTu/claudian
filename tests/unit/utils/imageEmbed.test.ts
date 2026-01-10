/**
 * Tests for imageEmbed utility - image wikilink to HTML conversion
 *
 * Tests the regex pattern matching and HTML generation logic.
 * DOM integration is tested manually in Obsidian.
 */

import type { App, TFile } from 'obsidian';

import { replaceImageEmbedsWithHtml } from '@/utils/imageEmbed';

// Mock App and vault for testing
function createMockApp(files: Map<string, string> = new Map()): App {
  const mockFiles = new Map<string, TFile>();
  files.forEach((resourcePath, filePath) => {
    mockFiles.set(filePath, {
      path: filePath,
      basename: filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || filePath,
    } as TFile);
  });

  return {
    vault: {
      getFileByPath: (path: string) => mockFiles.get(path) || null,
      getResourcePath: (file: TFile) => files.get(file.path) || `app://local/${file.path}`,
    },
    metadataCache: {
      getFirstLinkpathDest: (linkPath: string) => {
        // Try to find by basename
        for (const [path, file] of mockFiles) {
          if (path.endsWith(linkPath) || path === linkPath) {
            return file;
          }
        }
        return null;
      },
    },
  } as unknown as App;
}

describe('replaceImageEmbedsWithHtml', () => {
  describe('basic image embeds', () => {
    it('replaces simple image embed with img tag', () => {
      const app = createMockApp(new Map([['image.png', 'app://local/image.png']]));
      const result = replaceImageEmbedsWithHtml('![[image.png]]', app);

      expect(result).toContain('<img');
      expect(result).toContain('src="app://local/image.png"');
      expect(result).toContain('class="claudian-embedded-image"');
    });

    it('replaces image embed with folder path', () => {
      const app = createMockApp(new Map([['assets/photo.jpg', 'app://local/assets/photo.jpg']]));
      const result = replaceImageEmbedsWithHtml('![[assets/photo.jpg]]', app);

      expect(result).toContain('src="app://local/assets/photo.jpg"');
    });

    it('handles image in surrounding text', () => {
      const app = createMockApp(new Map([['test.png', 'app://local/test.png']]));
      const result = replaceImageEmbedsWithHtml('Check this ![[test.png]] image', app);

      expect(result).toContain('Check this');
      expect(result).toContain('image');
      expect(result).toContain('<img');
    });
  });

  describe('alt text and dimensions', () => {
    it('uses alt text from wikilink', () => {
      const app = createMockApp(new Map([['image.png', 'app://local/image.png']]));
      const result = replaceImageEmbedsWithHtml('![[image.png|My Alt Text]]', app);

      expect(result).toContain('alt="My Alt Text"');
    });

    it('applies width dimension from alt text', () => {
      const app = createMockApp(new Map([['image.png', 'app://local/image.png']]));
      const result = replaceImageEmbedsWithHtml('![[image.png|300]]', app);

      expect(result).toContain('style="width: 300px;"');
    });

    it('applies width and height dimensions', () => {
      const app = createMockApp(new Map([['image.png', 'app://local/image.png']]));
      const result = replaceImageEmbedsWithHtml('![[image.png|200x150]]', app);

      expect(result).toContain('style="width: 200px; height: 150px;"');
    });

    it('uses basename as alt when no alt text provided', () => {
      const app = createMockApp(new Map([['folder/my-image.png', 'app://local/folder/my-image.png']]));
      const result = replaceImageEmbedsWithHtml('![[folder/my-image.png]]', app);

      expect(result).toContain('alt="my-image"');
    });
  });

  describe('supported image extensions', () => {
    const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];

    extensions.forEach((ext) => {
      it(`replaces .${ext} image embed`, () => {
        const app = createMockApp(new Map([[`image.${ext}`, `app://local/image.${ext}`]]));
        const result = replaceImageEmbedsWithHtml(`![[image.${ext}]]`, app);

        expect(result).toContain('<img');
        expect(result).toContain(`src="app://local/image.${ext}"`);
      });
    });

    it('handles uppercase extensions (case-insensitive)', () => {
      const app = createMockApp(new Map([['photo.PNG', 'app://local/photo.PNG']]));
      const result = replaceImageEmbedsWithHtml('![[photo.PNG]]', app);

      expect(result).toContain('<img');
    });

    it('handles mixed case extensions', () => {
      const app = createMockApp(new Map([['image.JpG', 'app://local/image.JpG']]));
      const result = replaceImageEmbedsWithHtml('![[image.JpG]]', app);

      expect(result).toContain('<img');
    });
  });

  describe('non-image embeds (should pass through)', () => {
    it('leaves markdown file embed unchanged', () => {
      const app = createMockApp();
      const result = replaceImageEmbedsWithHtml('![[note.md]]', app);

      expect(result).toBe('![[note.md]]');
    });

    it('leaves pdf embed unchanged', () => {
      const app = createMockApp();
      const result = replaceImageEmbedsWithHtml('![[document.pdf]]', app);

      expect(result).toBe('![[document.pdf]]');
    });

    it('leaves audio embed unchanged', () => {
      const app = createMockApp();
      const result = replaceImageEmbedsWithHtml('![[audio.mp3]]', app);

      expect(result).toBe('![[audio.mp3]]');
    });

    it('processes only image embeds in mixed content', () => {
      const app = createMockApp(new Map([['image.png', 'app://local/image.png']]));
      const result = replaceImageEmbedsWithHtml('![[note.md]] and ![[image.png]]', app);

      expect(result).toContain('![[note.md]]');
      expect(result).toContain('<img');
    });
  });

  describe('file not found (fallback)', () => {
    it('shows fallback when image file not found', () => {
      const app = createMockApp(); // Empty vault
      const result = replaceImageEmbedsWithHtml('![[missing.png]]', app);

      expect(result).toContain('class="claudian-embedded-image-fallback"');
      expect(result).toContain('![[missing.png]]');
    });

    it('escapes HTML in fallback wikilink', () => {
      const app = createMockApp();
      const result = replaceImageEmbedsWithHtml('![[<script>alert(1)</script>.png]]', app);

      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });
  });

  describe('media folder resolution', () => {
    it('resolves image from media folder', () => {
      const app = createMockApp(new Map([['attachments/photo.png', 'app://local/attachments/photo.png']]));
      const result = replaceImageEmbedsWithHtml('![[photo.png]]', app, 'attachments');

      expect(result).toContain('src="app://local/attachments/photo.png"');
    });

    it('prefers direct path over media folder', () => {
      const app = createMockApp(
        new Map([
          ['image.png', 'app://local/image.png'],
          ['attachments/image.png', 'app://local/attachments/image.png'],
        ])
      );
      const result = replaceImageEmbedsWithHtml('![[image.png]]', app, 'attachments');

      expect(result).toContain('src="app://local/image.png"');
    });
  });

  describe('multiple image embeds', () => {
    it('replaces multiple images in text', () => {
      const app = createMockApp(
        new Map([
          ['a.png', 'app://local/a.png'],
          ['b.png', 'app://local/b.png'],
        ])
      );
      const result = replaceImageEmbedsWithHtml('![[a.png]] and ![[b.png]]', app);

      expect(result).toContain('src="app://local/a.png"');
      expect(result).toContain('src="app://local/b.png"');
    });

    it('replaces consecutive image embeds', () => {
      const app = createMockApp(
        new Map([
          ['1.png', 'app://local/1.png'],
          ['2.png', 'app://local/2.png'],
        ])
      );
      const result = replaceImageEmbedsWithHtml('![[1.png]]![[2.png]]', app);

      expect((result.match(/<img/g) || []).length).toBe(2);
    });
  });

  describe('HTML escaping (security)', () => {
    it('escapes HTML in image src', () => {
      const app = createMockApp(new Map([['test.png', 'app://local/path"><script>alert(1)</script>']]));
      const result = replaceImageEmbedsWithHtml('![[test.png]]', app);

      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('escapes HTML in alt text', () => {
      const app = createMockApp(new Map([['test.png', 'app://local/test.png']]));
      const result = replaceImageEmbedsWithHtml('![[test.png|<b>bold</b>]]', app);

      expect(result).not.toContain('<b>');
      expect(result).toContain('&lt;b&gt;');
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const app = createMockApp();
      const result = replaceImageEmbedsWithHtml('', app);

      expect(result).toBe('');
    });

    it('handles text without embeds', () => {
      const app = createMockApp();
      const result = replaceImageEmbedsWithHtml('Just plain text', app);

      expect(result).toBe('Just plain text');
    });

    it('handles incomplete embed syntax', () => {
      const app = createMockApp();
      const result = replaceImageEmbedsWithHtml('![[incomplete', app);

      expect(result).toBe('![[incomplete');
    });

    it('handles multiple sequential calls (regex lastIndex reset)', () => {
      const app = createMockApp(new Map([['a.png', 'app://local/a.png']]));

      // First call
      const result1 = replaceImageEmbedsWithHtml('![[a.png]]', app);
      // Second call - would fail without lastIndex reset
      const result2 = replaceImageEmbedsWithHtml('![[a.png]]', app);

      expect(result1).toContain('<img');
      expect(result2).toContain('<img');
    });

    it('replaces image embeds in multiline content', () => {
      const app = createMockApp(new Map([['test.png', 'app://local/test.png']]));
      const result = replaceImageEmbedsWithHtml(
        'First paragraph\n\n![[test.png]]\n\nThird paragraph',
        app
      );

      expect(result).toContain('<img');
      expect(result).toContain('First paragraph');
      expect(result).toContain('Third paragraph');
    });

    it('handles special characters in filename', () => {
      const filename = 'photo (2024-01-01).png';
      const app = createMockApp(new Map([[filename, `app://local/${filename}`]]));
      const result = replaceImageEmbedsWithHtml(`![[${filename}]]`, app);

      expect(result).toContain('<img');
    });

    it('handles spaces in filename', () => {
      const filename = 'my long image name.png';
      const app = createMockApp(new Map([[filename, `app://local/${filename}`]]));
      const result = replaceImageEmbedsWithHtml(`![[${filename}]]`, app);

      expect(result).toContain('<img');
    });

    it('handles deep folder paths', () => {
      const path = 'a/b/c/d/image.png';
      const app = createMockApp(new Map([[path, `app://local/${path}`]]));
      const result = replaceImageEmbedsWithHtml(`![[${path}]]`, app);

      expect(result).toContain('<img');
    });

    it('includes lazy loading attribute', () => {
      const app = createMockApp(new Map([['test.png', 'app://local/test.png']]));
      const result = replaceImageEmbedsWithHtml('![[test.png]]', app);

      expect(result).toContain('loading="lazy"');
    });
  });

  describe('error handling', () => {
    it('returns unchanged markdown when app is not initialized', () => {
      // @ts-expect-error - testing invalid input
      const result = replaceImageEmbedsWithHtml('![[image.png]]', null);

      expect(result).toBe('![[image.png]]');
    });

    it('returns unchanged markdown when vault is missing', () => {
      const app = { metadataCache: {} } as unknown as App;
      const result = replaceImageEmbedsWithHtml('![[image.png]]', app);

      expect(result).toBe('![[image.png]]');
    });

    it('returns unchanged markdown when metadataCache is missing', () => {
      const app = { vault: {} } as unknown as App;
      const result = replaceImageEmbedsWithHtml('![[image.png]]', app);

      expect(result).toBe('![[image.png]]');
    });

    it('returns fallback when getResourcePath throws', () => {
      const mockFile = { path: 'test.png', basename: 'test' } as TFile;
      const app = {
        vault: {
          getFileByPath: () => mockFile,
          getResourcePath: () => {
            throw new Error('Resource path failed');
          },
        },
        metadataCache: {
          getFirstLinkpathDest: () => null,
        },
      } as unknown as App;

      const result = replaceImageEmbedsWithHtml('![[test.png]]', app);

      expect(result).toContain('class="claudian-embedded-image-fallback"');
    });
  });

  describe('regular wikilinks (should NOT match)', () => {
    it('does not replace regular wikilink', () => {
      const app = createMockApp();
      const result = replaceImageEmbedsWithHtml('[[note.md]]', app);

      expect(result).toBe('[[note.md]]');
      expect(result).not.toContain('<img');
    });

    it('processes image embed but not file link', () => {
      const app = createMockApp(new Map([['image.png', 'app://local/image.png']]));
      const result = replaceImageEmbedsWithHtml('[[note.md]] and ![[image.png]]', app);

      expect(result).toContain('[[note.md]]');
      expect(result).toContain('<img');
    });
  });
});
