import { loadMermaid, setIcon } from 'obsidian';

interface MermaidApi {
  render(id: string, source: string, container: HTMLElement): Promise<{ svg: string }>;
}

let nextDiagramId = 0;

/** Uses the bundled diagram API directly, never Markdown code-block processors. */
export async function renderMermaidDiagrams(
  container: HTMLElement,
  isCurrent: () => boolean,
): Promise<void> {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre > code'))
    .filter(code => Array.from(code.classList).some(name => name.toLowerCase() === 'language-mermaid'));
  for (const code of blocks) {
    let staging: HTMLElement | undefined;
    try {
      const mermaid = await loadMermaid() as MermaidApi;
      if (!isCurrent() || !container.contains(code)) return;
      const doc = container.ownerDocument;
      staging = doc.body.createDiv({ cls: 'claudian-mermaid-staging' });
      const { svg } = await mermaid.render(`claudian-mermaid-${nextDiagramId++}`, code.textContent ?? '', staging);
      if (!isCurrent() || !container.contains(code) || typeof svg !== 'string') continue;
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (parsed.documentElement.localName !== 'svg'
        || parsed.querySelector('parsererror, .error-icon, .error-text')
        || !parsed.documentElement.children.length) continue;

      const wrapper = code.closest<HTMLElement>('.claudian-code-wrapper');
      if (!wrapper) continue;
      const diagram = staging.createDiv({ cls: 'claudian-mermaid' });
      const image = diagram.createEl('img');
      image.alt = 'Mermaid diagram';
      // An image document cannot execute SVG scripts or bind Mermaid click callbacks.
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      const source = diagram.createDiv();
      source.hidden = true;
      const toggle = diagram.createEl('button', {
        cls: 'claudian-mermaid-toggle',
        attr: { type: 'button' },
      });
      toggle.setAttribute('aria-label', 'Show diagram source');
      toggle.title = 'Show diagram source';
      setIcon(toggle, 'code-2');
      source.tabIndex = -1;
      const showSource = (visible: boolean) => {
        source.hidden = !visible;
        image.hidden = visible;
        toggle.hidden = visible;
        diagram.classList.toggle('claudian-mermaid--source', visible);
      };
      toggle.addEventListener('click', () => {
        showSource(true);
        source.focus({ preventScroll: true });
        const selection = doc.getSelection();
        const range = doc.createRange();
        range.selectNodeContents(code);
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      source.addEventListener('focusout', event => {
        if (event.relatedTarget instanceof doc.defaultView!.Node && source.contains(event.relatedTarget)) return;
        if (!image.parentElement) return;
        const selection = doc.getSelection();
        if (selection?.anchorNode && code.contains(selection.anchorNode)) selection.removeAllRanges();
        showSource(false);
      });
      wrapper.before(diagram);
      source.appendChild(wrapper);
      image.addEventListener('error', () => {
        showSource(true);
        toggle.remove();
        image.remove();
      }, { once: true });
    } catch {
      // The original code and its copy controls remain usable on any render failure.
    } finally {
      staging?.remove();
    }
  }
}
