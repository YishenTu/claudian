/**
 * @jest-environment jsdom
 */
import { processFileLinks } from '@/utils/fileLink';

function createMockApp(existingFiles: string[]) {
  const fileSet = new Set(existingFiles.map(f => f.toLowerCase()));

  return {
    metadataCache: {
      getFirstLinkpathDest: jest.fn((linkPath: string) => {
        return fileSet.has(linkPath.toLowerCase()) ? { path: linkPath } : null;
      }),
    },
    vault: {
      getFileByPath: jest.fn((filePath: string) => {
        if (fileSet.has(filePath.toLowerCase())) return { path: filePath };
        if (!filePath.endsWith('.md') && fileSet.has((filePath + '.md').toLowerCase())) {
          return { path: filePath + '.md' };
        }
        return null;
      }),
    },
  } as any;
}

describe('processFileLinks', () => {
  describe('null/empty inputs', () => {
    it('handles null app gracefully', () => {
      const container = document.createElement('div');
      expect(() => processFileLinks(null as any, container)).not.toThrow();
    });

    it('handles null container gracefully', () => {
      const app = createMockApp([]);
      expect(() => processFileLinks(app, null as any)).not.toThrow();
    });

    it('handles empty container', () => {
      const app = createMockApp([]);
      const container = document.createElement('div');
      processFileLinks(app, container);
      expect(container.innerHTML).toBe('');
    });
  });

  describe('text nodes with wikilinks', () => {
    it('converts valid wikilinks to clickable links', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const span = document.createElement('span');
      span.textContent = 'See [[note.md]] for info';
      container.appendChild(span);

      processFileLinks(app, container);

      const link = container.querySelector('a.claudian-file-link');
      expect(link).not.toBeNull();
      expect(link!.textContent).toBe('note.md');
      expect(link!.getAttribute('data-href')).toBe('note.md');
    });

    it('does not create links for non-existent files', () => {
      const app = createMockApp([]);
      const container = document.createElement('div');
      const span = document.createElement('span');
      span.textContent = 'See [[missing.md]] for info';
      container.appendChild(span);

      processFileLinks(app, container);

      const link = container.querySelector('a.claudian-file-link');
      expect(link).toBeNull();
    });

    it('preserves text around links', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const span = document.createElement('span');
      span.textContent = 'Before [[note.md]] after';
      container.appendChild(span);

      processFileLinks(app, container);

      expect(container.textContent).toBe('Before note.md after');
    });

    it('handles multiple wikilinks in one text node', () => {
      const app = createMockApp(['a.md', 'b.md']);
      const container = document.createElement('div');
      const span = document.createElement('span');
      span.textContent = '[[a.md]] and [[b.md]]';
      container.appendChild(span);

      processFileLinks(app, container);

      const links = container.querySelectorAll('a.claudian-file-link');
      expect(links.length).toBe(2);
    });

    it('handles display text in wikilinks', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const span = document.createElement('span');
      span.textContent = 'See [[note.md|My Note]]';
      container.appendChild(span);

      processFileLinks(app, container);

      const link = container.querySelector('a.claudian-file-link');
      expect(link).not.toBeNull();
      expect(link!.textContent).toBe('My Note');
    });

    it('resolves files without .md extension using vault fallback', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const span = document.createElement('span');
      span.textContent = 'See [[note]] here';
      container.appendChild(span);

      processFileLinks(app, container);

      const link = container.querySelector('a.claudian-file-link');
      expect(link).not.toBeNull();
    });
  });

  describe('inline code wikilinks', () => {
    it('processes wikilinks inside inline code elements', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const code = document.createElement('code');
      code.textContent = '[[note.md]]';
      container.appendChild(code);

      processFileLinks(app, container);

      const link = code.querySelector('a.claudian-file-link');
      expect(link).not.toBeNull();
      expect(link!.textContent).toBe('note.md');
    });

    it('skips code inside pre elements', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = '[[note.md]]';
      pre.appendChild(code);
      container.appendChild(pre);

      processFileLinks(app, container);

      const link = container.querySelector('a.claudian-file-link');
      expect(link).toBeNull();
      expect(code.textContent).toBe('[[note.md]]');
    });
  });

  describe('TreeWalker filtering', () => {
    it('skips text nodes inside pre elements', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const pre = document.createElement('pre');
      pre.textContent = '[[note.md]]';
      container.appendChild(pre);

      processFileLinks(app, container);

      const link = container.querySelector('a.claudian-file-link');
      expect(link).toBeNull();
    });

    it('skips text nodes inside a elements', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const anchor = document.createElement('a');
      anchor.textContent = '[[note.md]]';
      container.appendChild(anchor);

      processFileLinks(app, container);

      const links = container.querySelectorAll('a.claudian-file-link');
      expect(links.length).toBe(0);
    });

    it('skips text nodes inside elements with .claudian-file-link class', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const span = document.createElement('span');
      span.className = 'claudian-file-link';
      span.textContent = '[[note.md]]';
      container.appendChild(span);

      processFileLinks(app, container);

      // Should not create nested links
      const links = container.querySelectorAll('a.claudian-file-link');
      expect(links.length).toBe(0);
    });

    it('skips text nodes inside elements with .internal-link class', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const span = document.createElement('span');
      span.className = 'internal-link';
      span.textContent = '[[note.md]]';
      container.appendChild(span);

      processFileLinks(app, container);

      const links = container.querySelectorAll('a.claudian-file-link');
      expect(links.length).toBe(0);
    });

    it('processes text nodes in regular elements', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const p = document.createElement('p');
      p.textContent = '[[note.md]]';
      container.appendChild(p);

      processFileLinks(app, container);

      const link = container.querySelector('a.claudian-file-link');
      expect(link).not.toBeNull();
    });
  });

  describe('image embed exclusion', () => {
    it('does not convert image embeds to links', () => {
      const app = createMockApp(['image.png']);
      const container = document.createElement('div');
      const span = document.createElement('span');
      span.textContent = '![[image.png]]';
      container.appendChild(span);

      processFileLinks(app, container);

      const link = container.querySelector('a.claudian-file-link');
      expect(link).toBeNull();
    });

    it('converts file link but not image embed in same text', () => {
      const app = createMockApp(['note.md', 'image.png']);
      const container = document.createElement('div');
      const span = document.createElement('span');
      span.textContent = '[[note.md]] and ![[image.png]]';
      container.appendChild(span);

      processFileLinks(app, container);

      const links = container.querySelectorAll('a.claudian-file-link');
      expect(links.length).toBe(1);
      expect(links[0].textContent).toBe('note.md');
    });
  });
});
