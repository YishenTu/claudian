/**
 * @jest-environment jsdom
 */
import '@/providers';

import { MarkdownRenderer } from 'obsidian';

import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

jest.mock('@/utils/imageEmbed', () => ({
  replaceImageEmbedsWithHtml: jest.fn().mockImplementation((md: string) => md),
}));
jest.mock('@/utils/fileLink', () => ({
  processFileLinks: jest.fn(),
  registerFileLinkHandler: jest.fn().mockImplementation(() => jest.fn()),
}));

function createRenderer(): MessageRenderer {
  const plugin = {
    app: {},
    settings: { mediaFolder: '', renderDiagramsInChat: true },
  };
  const component = {
    registerDomEvent: jest.fn(),
    register: jest.fn(),
    addChild: jest.fn(),
    load: jest.fn(),
    unload: jest.fn(),
  };
  return new MessageRenderer(
    plugin as never,
    component as never,
    document.createElement('div'),
  );
}

function renderNeutralizedCodeBlock(source: string) {
  return async (renderedMarkdown: string, container: HTMLElement) => {
    const language = renderedMarkdown.match(/^[`~]+(\S+)/)?.[1] ?? '';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = `language-${language}`;
    code.textContent = source;
    pre.appendChild(code);
    container.appendChild(pre);
  };
}

const renderMarkdown = MarkdownRenderer.renderMarkdown as jest.Mock;

describe('MessageRenderer diagram rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    renderMarkdown.mockResolvedValue(undefined);
  });

  it('renders mermaid through an isolated Claudian-owned pass, never the main render', async () => {
    const renderer = createRenderer();
    const el = document.createElement('div');
    renderMarkdown.mockImplementationOnce(renderNeutralizedCodeBlock('flowchart TB'));

    await renderer.renderContent(el, '```mermaid title="sample"\nflowchart TB\n```');

    const calls = renderMarkdown.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toContain('```claudian-display-only-fence-0 title="sample"');
    expect(calls[0][0]).not.toContain('mermaid');
    // Only the fence body reaches the diagram renderer, inside a Claudian-owned host.
    expect(calls[1][0]).toBe('```mermaid\nflowchart TB\n```');
    expect(calls[1][1]).toBe(el.querySelector('.claudian-diagram-block'));
    expect(el.querySelector('pre')?.classList.contains('claudian-diagram-source-hidden'))
      .toBe(true);
  });

  it('escalates the diagram fence past backtick runs in the source', async () => {
    const renderer = createRenderer();
    const el = document.createElement('div');
    renderMarkdown.mockImplementationOnce(
      renderNeutralizedCodeBlock('flowchart TB\nA["```"]'),
    );

    await renderer.renderContent(el, '````mermaid\nflowchart TB\nA["```"]\n````');

    expect(renderMarkdown.mock.calls[1][0]).toBe('````mermaid\nflowchart TB\nA["```"]\n````');
  });

  it('keeps the source visible when the diagram render fails', async () => {
    const renderer = createRenderer();
    const el = document.createElement('div');
    renderMarkdown
      .mockImplementationOnce(renderNeutralizedCodeBlock('flowchart TB'))
      .mockRejectedValueOnce(new Error('mermaid unavailable'));

    await renderer.renderContent(el, '```mermaid\nflowchart TB\n```');

    expect(el.querySelector('pre')?.classList.contains('claudian-diagram-source-hidden'))
      .toBe(false);
    expect(el.querySelector('.claudian-diagram-block')).toBeNull();
  });

  it('leaves non-diagram fences out of the diagram path entirely', async () => {
    const renderer = createRenderer();
    const el = document.createElement('div');
    renderMarkdown.mockImplementationOnce(renderNeutralizedCodeBlock('TABLE file.name'));

    await renderer.renderContent(el, '```dataview\nTABLE file.name\n```');

    expect(renderMarkdown).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.claudian-diagram-block')).toBeNull();
  });
});
