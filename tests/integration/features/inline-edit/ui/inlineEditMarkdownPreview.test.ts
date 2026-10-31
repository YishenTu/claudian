/** @vitest-environment jsdom */
import { within } from '@testing-library/dom';
import { App, Component, MarkdownRenderer } from 'obsidian';
import type { Mock } from 'vitest';

import { renderInlineEditMarkdownPreview } from '@/features/inline-edit/ui/inlineEditMarkdownPreview';

describe('renderInlineEditMarkdownPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders markdown and math through Obsidian with the note source path', async () => {
    const app = new App();
    const component = new Component();
    const container = document.createElement('div');

    await renderInlineEditMarkdownPreview({
      app,
      component,
      container,
      markdown: '**Claim.** $Z(f)$ and $V(f)$ have the same parity.',
      sourcePath: 'math/note.md',
    });

    expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledWith(
      '**Claim.** $Z(f)$ and $V(f)$ have the same parity.',
      container,
      'math/note.md',
      component
    );
  });

  it('normalizes LaTeX math delimiters before rendering', async () => {
    const app = new App();
    const component = new Component();
    const container = document.createElement('div');

    await renderInlineEditMarkdownPreview({
      app,
      component,
      container,
      markdown: 'Inline \\(x<y\\).\n\\[y^2\\]\nPadded \\(  x + y  \\).',
      sourcePath: 'math/note.md',
    });

    expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledWith(
      'Inline $x<y$.\n$$y^2$$\nPadded $x + y$.',
      container,
      'math/note.md',
      component
    );
  });

  it('resolves image embeds using the note source path before rendering', async () => {
    const imageFile = {
      path: 'math/assets/image.png',
      basename: 'image',
    };
    const getFirstLinkpathDest = vi.fn()
      .mockImplementation((linkPath: string, sourcePath: string) => {
        return linkPath === 'image.png' && sourcePath === 'math/note.md'
          ? imageFile
          : null;
      });
    const app = Object.assign(new App(), {
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        getResourcePath: vi.fn().mockReturnValue('app://local/math/assets/image.png'),
      },
      metadataCache: {
        getFirstLinkpathDest,
      },
    });
    const component = new Component();
    const container = document.createElement('div');

    await renderInlineEditMarkdownPreview({
      app,
      component,
      container,
      markdown: '![[image.png]]',
      sourcePath: 'math/note.md',
    });

    expect(getFirstLinkpathDest).toHaveBeenCalledWith('image.png', 'math/note.md');
    expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledWith(
      expect.stringContaining('src="app://local/math/assets/image.png"'),
      container,
      'math/note.md',
      component
    );
  });

  it('prefers the source note image over the media folder collision', async () => {
    const sourceImage = { path: 'section/image.png', basename: 'image' };
    const files = new Map<string, unknown>([
      ['media/image.png', { path: 'media/image.png', basename: 'image' }],
      ['section/image.png', sourceImage],
    ]);
    const getFirstLinkpathDest = vi.fn()
      .mockImplementation((linkPath: string, sourcePath: string) =>
        linkPath === 'image.png' && sourcePath === 'section/note.md' ? sourceImage : null
      );
    const app = Object.assign(new App(), {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
        getResourcePath: vi.fn((file: { path: string }) => `app://local/${file.path}`),
      },
      metadataCache: {
        getFirstLinkpathDest,
      },
    });
    const component = new Component();
    const container = document.createElement('div');

    await renderInlineEditMarkdownPreview({
      app,
      component,
      container,
      markdown: '![[image.png]]',
      sourcePath: 'section/note.md',
      mediaFolder: 'media',
    });

    expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledWith(
      expect.stringContaining('src="app://local/section/image.png"'),
      container,
      'section/note.md',
      component
    );
    const rendered = (MarkdownRenderer.renderMarkdown as Mock).mock.calls[0][0] as string;
    expect(rendered).not.toContain('app://local/media/image.png');
  });

  it('falls back to raw markdown when Obsidian rendering fails', async () => {
    (MarkdownRenderer.renderMarkdown as Mock).mockRejectedValueOnce(new Error('render failed'));

    const app = new App();
    const component = new Component();
    const container = document.createElement('div');

    await renderInlineEditMarkdownPreview({
      app,
      component,
      container,
      markdown: 'Use $x^2$ here.',
      sourcePath: 'note.md',
    });

    expect(container.children).toHaveLength(1);
    expect(within(container).getByText('Use $x^2$ here.').classList.contains('claudian-inline-markdown-fallback')).toBe(true);
    expect(container.children[0].textContent).toBe('Use $x^2$ here.');
  });
});
