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
