/** @jest-environment jsdom */
import '@test/helpers/ObsidianSettingsDOM';

import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { TabBarItem } from '@/features/chat/tabs/ChatTab';
import { TabBar } from '@/features/chat/tabs/TabBar';

it('shows a semantic label, expands the history title, and restores the label', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const bar = new TabBar(container, { onTabClick: () => undefined, onTabClose: () => undefined });
  const item: TabBarItem = { id: 'one', index: 1, title: 'Repair conversation labels', shortTitle: 'Label repair', isActive: true, isWorking: false, attention: null, canClose: false };
  try {
    bar.update([item]);
    const badge = within(container).getByRole('button', { name: 'Repair conversation labels, active' });
    expect(badge.textContent).toBe('Label repair');
    fireEvent.dblClick(badge);
    expect(badge.textContent).toBe('Repair conversation labels');
    fireEvent.dblClick(badge);
    expect(badge.textContent).toBe('Label repair');
    expect(await axe(container, { rules: { region: { enabled: false } } })).toHaveNoViolations();
    bar.update([{ ...item, shortTitle: undefined }]);
    expect(within(container).getByLabelText('Repair conversation labels, active').textContent).toBe('1');
  } finally {
    bar.destroy();
    container.remove();
  }
});
