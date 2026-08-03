import { createMockEl } from '@test/helpers/MockElement';

import { renderCitationGroup } from '@/features/chat/rendering/CitationRenderer';

describe('CitationRenderer', () => {
  it('renders memory citations as a collapsed accessible disclosure', () => {
    const parentEl = createMockEl();

    const wrapperEl = renderCitationGroup(parentEl, {
      kind: 'memory',
      entries: [
        {
          path: 'MEMORY.md',
          lineStart: 10,
          lineEnd: 12,
          note: 'Used project conventions',
        },
        {
          path: 'rollout_summaries/session.md',
          lineStart: 4,
          lineEnd: 4,
          note: 'Confirmed the command',
        },
      ],
    });

    const headerEl = wrapperEl.querySelector('.claudian-citations-header');
    const contentEl = wrapperEl.querySelector('.claudian-citations-content');

    expect(headerEl?.getAttribute('role')).toBe('button');
    expect(headerEl?.getAttribute('tabindex')).toBe('0');
    expect(headerEl?.getAttribute('aria-expanded')).toBe('false');
    expect(headerEl?.children[1].textContent).toBe('Memory used');
    expect(headerEl?.children[2].textContent).toBe('2 sources');
    expect(contentEl?.hasClass('claudian-hidden')).toBe(true);

    (headerEl as HTMLElement | null)?.click();

    expect(headerEl?.getAttribute('aria-expanded')).toBe('true');
    expect(contentEl?.hasClass('claudian-hidden')).toBe(false);
    expect(contentEl?.children[0].children[0].textContent).toBe('MEMORY.md:10–12');
    expect(contentEl?.children[0].children[1].textContent).toBe('Used project conventions');
  });

  it('escapes citation values by rendering them as text', () => {
    const parentEl = createMockEl();

    const wrapperEl = renderCitationGroup(parentEl, {
      kind: 'memory',
      entries: [{
        path: '<img src=x onerror=alert(1)>',
        lineStart: 1,
        lineEnd: 1,
        note: '<script>alert(1)</script>',
      }],
    });
    const contentEl = wrapperEl.querySelector('.claudian-citations-content');

    expect(contentEl?.children[0].children[0].textContent).toBe(
      '<img src=x onerror=alert(1)>:1',
    );
    expect(contentEl?.children[0].children[1].textContent).toBe(
      '<script>alert(1)</script>',
    );
    expect(contentEl?.children[0].children).toHaveLength(2);
  });
});
