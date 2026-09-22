/** @jest-environment jsdom */
import { within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { renderOpencodeMigrationNotice } from '@/providers/opencode/ui/OpencodeMigrationNotice';

it('shows v1 users the migration deadline and clears it after upgrading', async () => {
  const container = document.body.createDiv();
  try {
    const update = renderOpencodeMigrationNotice(container);
    update('1.18.32');
    const ui = within(container);
    expect(ui.getByRole('status').textContent).toContain('OpenCode v1 support ends on October 30, 2026.');
    expect(ui.getByRole('link', { name: 'Migrate to OpenCode v2' }).getAttribute('href'))
      .toBe('https://opencode.ai/v2/docs/migrate-v1');
    expect(await axe(container)).toHaveNoViolations();
    update('2.0.12');
    expect(ui.queryByRole('status')).toBeNull();
    update(null);
    expect(ui.queryByRole('status')).toBeNull();
  } finally {
    container.remove();
  }
});
