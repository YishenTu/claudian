import { updateContextRowHasContent } from '@/features/chat/controllers/contextRowVisibility';

function createContextRow(browserIndicator: HTMLElement | null): HTMLElement {
  const editorIndicator = { style: { display: 'none' } };
  const canvasIndicator = { style: { display: 'none' } };
  const fileIndicator = { style: { display: 'none' } };
  const imagePreview = { style: { display: 'none' } };
  const lookup = new Map<string, unknown>([
    ['.claudian-selection-indicator', editorIndicator],
    ['.claudian-browser-selection-indicator', browserIndicator],
    ['.claudian-canvas-indicator', canvasIndicator],
    ['.claudian-file-indicator', fileIndicator],
    ['.claudian-image-preview', imagePreview],
  ]);

  return {
    classList: {
      toggle: jest.fn(),
    },
    querySelector: jest.fn((selector: string) => lookup.get(selector) ?? null),
  } as unknown as HTMLElement;
}

describe('updateContextRowHasContent', () => {
  it('does not treat missing browser indicator as visible content', () => {
    const contextRowEl = createContextRow(null);

    expect(() => updateContextRowHasContent(contextRowEl)).not.toThrow();
    expect((contextRowEl.classList.toggle as jest.Mock)).toHaveBeenCalledWith('has-content', false);
  });

  it('treats browser indicator as visible only when display is block', () => {
    const browserIndicator = { style: { display: 'block' } } as unknown as HTMLElement;
    const contextRowEl = createContextRow(browserIndicator);

    updateContextRowHasContent(contextRowEl);

    expect((contextRowEl.classList.toggle as jest.Mock)).toHaveBeenCalledWith('has-content', true);
  });
});
