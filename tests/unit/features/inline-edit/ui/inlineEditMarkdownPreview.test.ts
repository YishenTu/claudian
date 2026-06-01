import { createMockEl } from '@test/helpers/mockElement';
import { MarkdownRenderer } from 'obsidian';

import { renderInlineEditMarkdownPreview } from '@/features/inline-edit/ui/inlineEditMarkdownPreview';

describe('renderInlineEditMarkdownPreview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders markdown and math through Obsidian with the note source path', async () => {
    const app = { vault: {}, metadataCache: {} } as any;
    const component = {} as any;
    const container = createMockEl();

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

  it('resolves image embeds using the note source path before rendering', async () => {
    const imageFile = {
      path: 'math/assets/image.png',
      basename: 'image',
    };
    const getFirstLinkpathDest = jest
      .fn()
      .mockImplementation((linkPath: string, sourcePath: string) => {
        return linkPath === 'image.png' && sourcePath === 'math/note.md'
          ? imageFile
          : null;
      });
    const app = {
      vault: {
        getAbstractFileByPath: jest.fn().mockReturnValue(null),
        getResourcePath: jest.fn().mockReturnValue('app://local/math/assets/image.png'),
      },
      metadataCache: {
        getFirstLinkpathDest,
      },
    } as any;
    const component = {} as any;
    const container = createMockEl();

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

  it('falls back to raw markdown when Obsidian rendering fails', async () => {
    (MarkdownRenderer.renderMarkdown as jest.Mock).mockRejectedValueOnce(new Error('render failed'));

    const app = { vault: {}, metadataCache: {} } as any;
    const component = {} as any;
    const container = createMockEl();

    await renderInlineEditMarkdownPreview({
      app,
      component,
      container,
      markdown: 'Use $x^2$ here.',
      sourcePath: 'note.md',
    });

    expect(container.children).toHaveLength(1);
    expect(container.children[0].hasClass('claudian-inline-markdown-fallback')).toBe(true);
    expect(container.children[0].textContent).toBe('Use $x^2$ here.');
  });
});
