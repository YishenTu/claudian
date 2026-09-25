/** @jest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';

import { frameSettingsGroups } from '@/shared/settings/SettingsGroups';

describe('settings group presentation', () => {
  it('frames existing heading ranges without changing controls or their order', () => {
    const page = document.createElement('div');
    page.innerHTML = '<div>Language</div><div class="setting-item-heading">Display</div><button type="button">Toggle display</button><div>Placement</div><div class="setting-item-heading">Input</div><input aria-label="Send shortcut">';
    let clicked = false;
    const button = within(page).getByRole('button', { name: 'Toggle display' });
    button.addEventListener('click', () => { clicked = true; });
    frameSettingsGroups(page);
    const groups = within(page).getAllByRole('group');
    expect(groups.map(group => group.getAttribute('aria-label'))).toEqual(['Display', 'Input']);
    expect(groups[0].textContent).toBe('DisplayToggle displayPlacement');
    expect(within(groups[1]).getByRole('textbox', { name: 'Send shortcut' })).toBeTruthy();
    expect(page.firstElementChild?.textContent).toBe('Language');
    fireEvent.click(within(groups[0]).getByRole('button', { name: 'Toggle display' }));
    expect(clicked).toBe(true);
    frameSettingsGroups(page);
    expect(within(page).getAllByRole('group')).toHaveLength(2);
  });

  it('leaves an unheaded page in its existing layout', () => {
    const page = document.createElement('div');
    page.innerHTML = '<div>Enable feature</div><div>Output folder</div>';
    frameSettingsGroups(page);
    expect(page.textContent).toBe('Enable featureOutput folder');
    expect(within(page).queryByRole('group')).toBeNull();
  });
});
