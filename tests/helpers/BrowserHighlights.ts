/** CSS Custom Highlight capability absent from jsdom. Tracks real ranges; it does not render geometry. */
export function installBrowserHighlights() {
  class BrowserHighlight {
    constructor(...ranges: Range[]) { this.ranges = ranges; }
    readonly ranges: Range[];
  }
  const highlights = new Map<string, BrowserHighlight>();
  vi.stubGlobal('CSS', { ...globalThis.CSS, highlights });
  vi.stubGlobal('Highlight', BrowserHighlight);
  return highlights;
}
