/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Chat code styles', () => {
  const css = readFileSync(path.resolve('src/style/components/code.css'), 'utf8');

  afterEach(() => {
    document.head.querySelector('[data-testid="code-styles"]')?.remove();
    document.body.replaceChildren();
    document.body.removeAttribute('class');
  });

  function renderCodeSamples(): {
    blockCode: HTMLElement;
    inlineCode: HTMLElement;
    pre: HTMLPreElement;
  } {
    const style = document.createElement('style');
    style.dataset.testid = 'code-styles';
    style.textContent = css;
    document.head.appendChild(style);

    document.body.innerHTML = `
      <div class="claudian-container">
        <div class="claudian-message-content">
          <p>Use <code data-testid="inline-code">test</code></p>
          <pre><code data-testid="block-code">block</code></pre>
        </div>
      </div>
    `;

    return {
      blockCode: document.querySelector('[data-testid="block-code"]') as HTMLElement,
      inlineCode: document.querySelector('[data-testid="inline-code"]') as HTMLElement,
      pre: document.querySelector('pre') as HTMLPreElement,
    };
  }

  it('gives inline code a readable surface inside chat messages', () => {
    const { inlineCode } = renderCodeSamples();
    const inlineStyle = window.getComputedStyle(inlineCode);

    expect({
      backgroundColor: inlineStyle.backgroundColor,
      borderRadius: inlineStyle.borderRadius,
      boxDecorationBreak: inlineStyle.getPropertyValue('box-decoration-break'),
      color: inlineStyle.color,
      padding: inlineStyle.padding,
    }).toEqual({
      backgroundColor: 'var(--code-background, var(--background-secondary))',
      borderRadius: '4px',
      boxDecorationBreak: 'clone',
      color: 'var(--code-normal, var(--text-normal))',
      padding: '0.1em 0.35em',
    });
  });

  it('keeps the existing code block surface on pre instead of its code child', () => {
    const { blockCode, pre } = renderCodeSamples();
    const blockCodeStyle = window.getComputedStyle(blockCode);
    const preStyle = window.getComputedStyle(pre);

    expect({
      backgroundColor: preStyle.backgroundColor,
      borderRadius: preStyle.borderRadius,
      padding: preStyle.padding,
    }).toEqual({
      backgroundColor: 'rgba(0, 0, 0, 0.2)',
      borderRadius: '6px',
      padding: '8px 12px',
    });
    expect({
      backgroundColor: blockCodeStyle.backgroundColor,
      borderRadius: blockCodeStyle.borderRadius,
      boxDecorationBreak: blockCodeStyle.getPropertyValue('box-decoration-break'),
      padding: blockCodeStyle.padding,
    }).toEqual({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderRadius: '',
      boxDecorationBreak: '',
      padding: '',
    });
  });
});
