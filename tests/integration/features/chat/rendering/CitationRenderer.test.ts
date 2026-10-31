/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { fireEvent, within } from '@testing-library/dom';

import { renderCitationGroup } from '@/features/chat/rendering/CitationRenderer';

afterEach(() => document.body.replaceChildren());

it('opens memory citations with the keyboard and preserves line ranges and notes', async () => {
  const host = document.body.createDiv();
  renderCitationGroup(host, {
    kind: 'memory',
    entries: [
      { path: 'MEMORY.md', lineStart: 10, lineEnd: 12, note: 'Used project conventions' },
      { path: 'rollout_summaries/session.md', lineStart: 4, lineEnd: 4, note: 'Confirmed the command' },
    ],
  });
  const disclosure = within(host).getByRole('button', { name: 'Memory used, 2 sources - click to expand' });
  expect(disclosure.getAttribute('aria-expanded')).toBe('false');
  disclosure.focus();
  expect(document.activeElement).toBe(disclosure);
  fireEvent.keyDown(disclosure, { key: 'Enter' });
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  for (const text of ['MEMORY.md:10–12', 'Used project conventions', 'rollout_summaries/session.md:4', 'Confirmed the command']) {
    expect(within(host).getByText(text)).toBeDefined();
  }
  fireEvent.keyDown(disclosure, { key: ' ' });
  expect(disclosure.getAttribute('aria-expanded')).toBe('false');
  expect(await axe(host)).toHaveNoViolations();
});

it('renders hostile citation paths and notes as text without creating elements', () => {
  const host = document.body.createDiv();
  renderCitationGroup(host, {
    kind: 'memory',
    entries: [{ path: '<img src=x onerror=alert(1)>', lineStart: 1, lineEnd: 1, note: '<script>alert(1)</script>' }],
  });
  fireEvent.click(within(host).getByRole('button', { name: 'Memory used, 1 source - click to expand' }));
  expect(within(host).getByText('<img src=x onerror=alert(1)>:1')).toBeDefined();
  expect(within(host).getByText('<script>alert(1)</script>')).toBeDefined();
  expect(host.querySelector('img, script')).toBeNull();
});
