export function updateContextRowHasContent(contextRowEl: HTMLElement): void {
  const editorIndicator = contextRowEl.querySelector('.claudian-selection-indicator');
  const browserIndicator = contextRowEl.querySelector('.claudian-browser-selection-indicator');
  const canvasIndicator = contextRowEl.querySelector('.claudian-canvas-indicator');
  const fileIndicator = contextRowEl.querySelector('.claudian-file-indicator');
  const imagePreview = contextRowEl.querySelector('.claudian-image-preview');

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
