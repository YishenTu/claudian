/** @vitest-environment jsdom */

import {
  ANTIGRAVITY_PROVIDER_ICON,
  createProviderIconSvg,
  OPENAI_PROVIDER_ICON,
  OPENCODE_PROVIDER_ICON,
  PI_PROVIDER_ICON,
} from '@/shared/icons';

describe('createProviderIconSvg', () => {
  it('renders path-based provider icons with currentColor fill', () => {
    const svg = createProviderIconSvg(OPENAI_PROVIDER_ICON, {
      className: 'test-icon',
      height: 12,
      parent: document.body,
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
      parent: document.body,
      width: 18,
    });

    expect(svg.getAttribute('data-provider')).toBe('opencode');
    expect(svg.getAttribute('viewBox')).toBe(OPENCODE_PROVIDER_ICON.viewBox);
    expect(svg.querySelector('.claudian-provider-icon-variant--light')).not.toBeNull();
    expect(svg.querySelector('.claudian-provider-icon-variant--dark')).not.toBeNull();
  });

  it('renders the Pi provider icon as currentColor composite paths', () => {
    const svg = createProviderIconSvg(PI_PROVIDER_ICON, {
      dataProvider: 'pi',
      parent: document.body,
    });

    expect(svg.getAttribute('viewBox')).toBe('0 0 800 800');
    const paths = Array.from(svg.querySelectorAll('path'));
    expect(paths).toHaveLength(2);
    expect(paths[0].getAttribute('fill-rule')).toBe('evenodd');
    expect(paths.every(path => path.getAttribute('fill') === 'currentColor')).toBe(true);
  });

  it('keeps each full-colour Antigravity icon\'s mask and blur references inside its own SVG', () => {
    const first = createProviderIconSvg(ANTIGRAVITY_PROVIDER_ICON, { parent: document.body });
    const second = createProviderIconSvg(ANTIGRAVITY_PROVIDER_ICON, { parent: document.body });
    document.body.append(first, second);

    for (const svg of [first, second]) {
      expect(svg.querySelectorAll('mask')).toHaveLength(1);
      expect(svg.querySelectorAll('filter feGaussianBlur')).toHaveLength(11);
      expect(svg.querySelectorAll('[fill="#FC413D"], [fill="#00B95C"], [fill="#FFE432"]').length).toBeGreaterThan(0);
      const references = Array.from(svg.querySelectorAll('[mask], [filter]'))
        .flatMap(element => [element.getAttribute('mask'), element.getAttribute('filter')])
        .filter((value): value is string => Boolean(value));
      expect(references).toHaveLength(12);
      for (const reference of references) {
        const id = /^url\(#(.+)\)$/.exec(reference)?.[1];
        expect(id).toBeDefined();
        // A duplicate id would make the second icon borrow the first icon's mask or blur.
        expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
        expect(svg.querySelector(`[id="${id}"]`)).not.toBeNull();
      }
    }
    first.remove();
    second.remove();
  });
});
