/** @jest-environment jsdom */

import {
  createProviderIconSvg,
  OPENAI_PROVIDER_ICON,
  OPENCODE_PROVIDER_ICON,
} from '@/shared/icons';

describe('createProviderIconSvg', () => {
  it('renders path-based provider icons with currentColor fill', () => {
    const svg = createProviderIconSvg(OPENAI_PROVIDER_ICON, {
      className: 'test-icon',
      height: 12,
      ownerDocument: document,
      width: 12,
    });

    expect(svg.getAttribute('viewBox')).toBe(OPENAI_PROVIDER_ICON.viewBox);
    expect(svg.getAttribute('width')).toBe('12');
    expect(svg.getAttribute('height')).toBe('12');
    expect(svg.classList.contains('claudian-provider-icon')).toBe(true);
    expect(svg.classList.contains('test-icon')).toBe(true);

    const path = svg.querySelector('path');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('fill')).toBe('currentColor');
  });

  it('renders composite provider icons with theme variants', () => {
    const svg = createProviderIconSvg(OPENCODE_PROVIDER_ICON, {
      dataProvider: 'opencode',
      height: 18,
      ownerDocument: document,
      width: 18,
    });

    expect(svg.getAttribute('data-provider')).toBe('opencode');
    expect(svg.getAttribute('viewBox')).toBe(OPENCODE_PROVIDER_ICON.viewBox);
    expect(svg.querySelector('.claudian-provider-icon-variant--light')).not.toBeNull();
    expect(svg.querySelector('.claudian-provider-icon-variant--dark')).not.toBeNull();
  });
});
