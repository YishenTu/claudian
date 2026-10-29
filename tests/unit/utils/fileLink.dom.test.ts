/**
 * @vitest-environment jsdom
 */
import { axe } from '@test/helpers/accessibility';
import { fireEvent, within } from '@testing-library/dom';

import { processFileLinks, registerFileLinkHandler } from '@/utils/fileLink';

function createMockApp(existingFiles: string[]) {
  const fileSet = new Set(existingFiles.map(f => f.toLowerCase()));

  return {
    metadataCache: {
      getFirstLinkpathDest: vi.fn((linkPath: string) => {
        return fileSet.has(linkPath.toLowerCase()) ? { path: linkPath } : null;
      }),
    },
    vault: {
      getAbstractFileByPath: vi.fn((filePath: string) => {
        if (fileSet.has(filePath.toLowerCase())) return { path: filePath, basename: filePath.replace(/\.md$/, '') };
        if (!filePath.endsWith('.md') && fileSet.has((filePath + '.md').toLowerCase())) {
          return { path: filePath + '.md', basename: filePath };
        }
        return null;
      }),
    },
  } as any;
}

describe('processFileLinks', () => {
  it.each(['', 'note.md'])('uses only the explicit source for same-note targets (%s)', async sourcePath => {
    const app = createMockApp(['note.md']);
    app.workspace = { getActiveFile: vi.fn(() => ({ path: 'note.md', basename: 'note' })) };
    const container = document.createElement('main');
    const code = container.appendChild(document.createElement('code'));
    code.textContent = '[[#Overview]] and [[#^quote-of-the-day]]';
    processFileLinks(app, container, sourcePath);
    expect(app.workspace.getActiveFile).not.toHaveBeenCalled();
    expect(within(container).queryAllByRole('link').map(link => [link.textContent, link.getAttribute('data-href')]))
      .toEqual(sourcePath ? [['#Overview', '#Overview'], ['#^quote-of-the-day', '#^quote-of-the-day']] : []);
    expect(code.textContent).toBe(sourcePath ? '#Overview and #^quote-of-the-day' : '[[#Overview]] and [[#^quote-of-the-day]]');
    expect(await axe(container)).toHaveNoViolations();
  });

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

    it.each([
      ['span', '[[note.md|My Note]]', 'note.md', 'My Note'],
      ['span', '[[note.md|Left | Right]]', 'note.md', 'Left | Right'],
      ['code', '[[note.md#section|Left | Right]]', 'note.md#section', 'Left | Right'],
      ['code', '[[note.md|Trailing |]]', 'note.md', 'Trailing |'],
    ])('handles complete display text in %s: %s', async (tag, source, target, label) => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      const element = document.createElement(tag);
      element.textContent = `See ${source} here`;
      container.appendChild(element);

      processFileLinks(app, container);

      const link = within(element).getByRole('link', { name: label });
      expect(link.textContent).toBe(label);
      expect(link.getAttribute('href')).toBe(target);
      expect(link.getAttribute('data-href')).toBe(target);
      expect(element.textContent).toBe(`See ${label} here`);
      expect((await axe(element, {
        runOnly: { type: 'rule', values: ['link-name'] },
      })).violations).toEqual([]);
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

    it('keeps inline-code labels inside existing links owned by their original anchor', async () => {
      const app = createMockApp(['note.md']);
      app.workspace = {
        iterateAllLeaves: vi.fn(),
        openLinkText: vi.fn().mockResolvedValue(undefined),
      };
      const container = document.createElement('div');
      container.innerHTML = '<a href="https://example.com/guide"><code>[[note.md]]</code></a> and <code>[[note.md]]</code>';
      document.body.appendChild(container);
      const originalLink = within(container).getByRole('link', { name: '[[note.md]]' });
      const cleanup = registerFileLinkHandler(app, container);
      // Prevent browser navigation while keeping application delegation active.
      originalLink.addEventListener('click', event => event.preventDefault());
      try {
        processFileLinks(app, container);

        expect(within(container).getAllByRole('link')).toHaveLength(2);
        expect(within(originalLink).queryByRole('link')).toBeNull();
        expect(originalLink.getAttribute('href')).toBe('https://example.com/guide');
        expect(originalLink.textContent).toBe('[[note.md]]');
        fireEvent.click(originalLink.querySelector('code')!);
        expect(app.workspace.openLinkText).not.toHaveBeenCalled();
        const fileLink = within(container).getByRole('link', { name: 'note.md' });
        fireEvent.click(fileLink);
        expect(app.workspace.openLinkText).toHaveBeenCalledWith('note.md', '', 'tab');
        expect((await axe(container, {
          runOnly: { type: 'rule', values: ['link-name'] },
        })).violations).toEqual([]);
      } finally {
        cleanup();
        container.remove();
      }
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

    it('repairs empty resolved internal-link anchors while leaving missing wikilinks visible', () => {
      const app = createMockApp(['note.md']);
      const container = document.createElement('div');
      container.innerHTML = '<a class="internal-link" href="note"></a> and [[missing.md]]';

      processFileLinks(app, container);

      const internalLink = container.querySelector('a.internal-link');
      expect(internalLink).not.toBeNull();
      expect(internalLink!.textContent).toBe('note');
      expect(internalLink!.classList.contains('claudian-file-link')).toBe(true);
      expect(container.textContent).toBe('note and [[missing.md]]');
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
