/** @jest-environment jsdom */

import {
  createProviderIconSvg,
  OPENAI_PROVIDER_ICON,
  OPENCODE_PROVIDER_ICON,
  PI_PROVIDER_ICON,
  QODER_PROVIDER_ICON,
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

  it('renders the official Qoder mark with its two brand greens', () => {
    const svg = createProviderIconSvg(QODER_PROVIDER_ICON, {
      dataProvider: 'qoder',
      parent: document.body,
    });

    expect(svg.getAttribute('viewBox')).toBe('0 0 56 56');
    const paths = Array.from(svg.querySelectorAll('path'));
    expect(paths).toHaveLength(2);
    expect(paths.map(path => path.getAttribute('fill'))).toEqual(['#27BD51', '#2ADB5C']);
    expect(paths[1].getAttribute('fill-rule')).toBe('evenodd');
  });
});
