export function updateContextRowHasContent(contextRowEl: HTMLElement): void {
  const editorIndicator = contextRowEl.querySelector('.claudian-selection-indicator') as HTMLElement | null;
  const browserIndicator = contextRowEl.querySelector('.claudian-browser-selection-indicator') as HTMLElement | null;
  const canvasIndicator = contextRowEl.querySelector('.claudian-canvas-indicator') as HTMLElement | null;
  const fileIndicator = contextRowEl.querySelector('.claudian-file-indicator') as HTMLElement | null;
  const imagePreview = contextRowEl.querySelector('.claudian-image-preview') as HTMLElement | null;

  const hasEditorSelection = !!editorIndicator && !editorIndicator.hasClass('claudian-hidden');
  const hasBrowserSelection = !!browserIndicator && !browserIndicator.hasClass('claudian-hidden');
  const hasCanvasSelection = !!canvasIndicator && !canvasIndicator.hasClass('claudian-hidden');
  const hasFileChips = !!fileIndicator && fileIndicator.hasClass('claudian-visible-flex');
  const hasImageChips = !!imagePreview && imagePreview.hasClass('claudian-visible-flex');

  contextRowEl.classList.toggle(
    'has-content',
    hasEditorSelection || hasBrowserSelection || hasCanvasSelection || hasFileChips || hasImageChips
  );
}
