/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Long conversation message styles', () => {
  const css = readFileSync(path.resolve('src/style/components/messages.css'), 'utf8');

  afterEach(() => {
    document.head.querySelector('[data-testid="messages-styles"]')?.remove();
    document.body.replaceChildren();
    document.body.removeAttribute('class');
  });

  function getAssistantStyle(platformClass: string): CSSStyleDeclaration {
    const style = document.createElement('style');
    style.dataset.testid = 'messages-styles';
    style.textContent = css;
    document.head.appendChild(style);

    document.body.classList.add(platformClass);
    const assistantMessage = document.createElement('div');
    assistantMessage.className = 'claudian-message-assistant';
    document.body.appendChild(assistantMessage);

    return window.getComputedStyle(assistantMessage);
  }

  it('disables assistant layout isolation on Windows', () => {
    const assistantStyle = getAssistantStyle('mod-windows');

    expect({
      contentVisibility: assistantStyle.getPropertyValue('content-visibility'),
      containIntrinsicSize: assistantStyle.getPropertyValue('contain-intrinsic-size'),
    }).toEqual({
      contentVisibility: 'visible',
      containIntrinsicSize: 'none',
    });
  });

  it.each([
    ['macOS', 'mod-macos'],
    ['Linux', 'mod-linux'],
  ])('keeps assistant layout isolation on %s', (_platform, platformClass) => {
    const assistantStyle = getAssistantStyle(platformClass);

    expect({
      contentVisibility: assistantStyle.getPropertyValue('content-visibility'),
      containIntrinsicSize: assistantStyle.getPropertyValue('contain-intrinsic-size'),
    }).toEqual({
      contentVisibility: 'auto',
      containIntrinsicSize: 'auto 23.5rem',
    });
  });
});

describe('User message list containment', () => {
  it('keeps ordered-list markers inside the message bubble', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(path.resolve('src/style/components/messages.css'), 'utf8');
    document.head.appendChild(style);

    const message = document.createElement('div');
    message.className = 'claudian-message claudian-message-user';
    message.innerHTML = `
      <div class="claudian-message-content">
        <ol start="9"><li></li><li></li></ol>
      </div>
    `;
    document.body.appendChild(message);

    try {
      const list = message.querySelector('ol')!;
      expect(window.getComputedStyle(list).listStylePosition).toBe('inside');
    } finally {
      message.remove();
      style.remove();
    }
  });
});

describe('Message action row visibility', () => {
  function revealSelectors(): string[] {
    const style = document.createElement('style');
    style.textContent = readFileSync(path.resolve('src/style/components/messages.css'), 'utf8');
    document.head.appendChild(style);
    try {
      const rules = Array.from(style.sheet?.cssRules ?? []) as CSSStyleRule[];
      return rules
        .filter(rule => rule.style?.getPropertyValue('opacity') === '1')
        .flatMap(rule => rule.selectorText.split(',').map(selector => selector.trim()))
        .filter(selector => /\.claudian-message-actions(:[\w-]+)?$/.test(selector));
    } finally {
      style.remove();
    }
  }

  it('reveals the row on hover, and on focus only from its own controls', () => {
    const selectors = revealSelectors();

    expect(selectors).toContain('.claudian-message:hover > .claudian-message-actions');
    expect(selectors).toContain('.claudian-message-images:hover > .claudian-message-actions');
    expect(selectors).toContain('.claudian-message-actions:focus-within');
    // Focus on a collapsible header elsewhere in the turn must not reveal the row.
    expect(selectors.filter(selector => /:focus/.test(selector)
      && !selector.startsWith('.claudian-message-actions:focus'))).toEqual([]);
    expect(selectors.filter(selector => !/:hover|:focus/.test(selector))).toEqual([]);
  });

  it.each(['user', 'assistant', 'images'])('keeps the %s row hidden in its hover area at rest', (kind) => {
    const style = document.createElement('style');
    style.textContent = readFileSync(path.resolve('src/style/components/messages.css'), 'utf8');
    document.head.appendChild(style);
    const message = document.createElement('div');
    message.className = kind === 'images' ? 'claudian-message-images' : `claudian-message claudian-message-${kind}`;
    const actions = document.createElement('div');
    actions.className = 'claudian-message-actions claudian-user-msg-actions';
    actions.innerHTML = '<button type="button">Copy message</button>';
    message.appendChild(actions);
    document.body.appendChild(message);
    try {
      const computed = window.getComputedStyle(actions);
      expect(computed.opacity).toBe('0');
      expect(computed.display).toBe('flex');
    } finally {
      message.remove();
      style.remove();
    }
  });
});
