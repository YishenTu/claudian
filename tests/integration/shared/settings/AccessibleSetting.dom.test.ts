/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { fireEvent, within } from '@testing-library/dom';
import type { ToggleComponent } from 'obsidian';

import { AccessibleSetting } from '@/shared/settings/AccessibleSetting';

afterEach(() => document.body.replaceChildren());

function expectSwitchState(container: HTMLElement, name: string, checked: boolean): HTMLElement {
  const element = within(container).getByRole('switch', { name, checked });
  expect(element.getAttribute('aria-checked')).toBe(String(checked));
  return element;
}

it('associates native controls with distinct visible names and follows name changes', async () => {
  const container = document.body.createDiv();
  const first = new AccessibleSetting(container).setName('Name').addText(() => {});
  new AccessibleSetting(container).setName('Instructions').addTextArea(() => {});
  new AccessibleSetting(container).setName('Mode').addDropdown(control => control.addOption('auto', 'Auto'));
  const ui = within(container);
  const name = ui.getByRole('textbox', { name: 'Name' });
  expect(ui.getByRole('textbox', { name: 'Instructions' })).toBeTruthy();
  expect(ui.getByRole('combobox', { name: 'Mode' })).toBeTruthy();
  first.setName('Display name');
  expect(ui.getByRole('textbox', { name: 'Display name' })).toBe(name);
  expect(await axe(container, {
    runOnly: ['label', 'select-name', 'duplicate-id-aria'],
  })).toHaveNoViolations();
});

it('preserves explicit control names that are more specific than the setting name', async () => {
  const container = document.body.createDiv();
  new AccessibleSetting(container).setName('Path').addText(control => {
    control.inputEl.setAttribute('aria-label', 'CLI path');
  });
  new AccessibleSetting(container).setName('Instructions').addTextArea(control => {
    control.inputEl.setAttribute('aria-label', 'Project instructions');
  });
  new AccessibleSetting(container).setName('Mode').addDropdown(control => {
    control.addOption('auto', 'Auto').selectEl.setAttribute('aria-label', 'Execution mode');
  });
  new AccessibleSetting(container).setName('Enabled').addToggle(control => {
    control.toggleEl.setAttribute('aria-label', 'Enable provider');
  });
  const ui = within(container);
  expect(ui.getByRole('textbox', { name: 'CLI path' })).toBeTruthy();
  expect(ui.getByRole('textbox', { name: 'Project instructions' })).toBeTruthy();
  expect(ui.getByRole('combobox', { name: 'Execution mode' })).toBeTruthy();
  expect(expectSwitchState(container, 'Enable provider', false)).toBeTruthy();
  expect(await axe(container, {
    runOnly: ['label', 'select-name', 'aria-toggle-field-name', 'aria-required-attr'],
  })).toHaveNoViolations();
});

it('exposes the host toggle state for pointer, keyboard, programmatic and disabled changes', async () => {
  const container = document.body.createDiv();
  let toggle!: ToggleComponent;
  const changes: boolean[] = [];
  const setting = new AccessibleSetting(container).setName('Enabled').addToggle(control => {
    toggle = control;
    control.setValue(true).onChange(value => { changes.push(value); });
  });
  const ui = within(container);
  const element = expectSwitchState(container, 'Enabled', true);
  expect(ui.queryByRole('checkbox')).toBeNull();
  element.focus();
  expect(document.activeElement).toBe(element);
  fireEvent.keyDown(element, { key: 'Enter' });
  expect(expectSwitchState(container, 'Enabled', false)).toBe(element);
  fireEvent.keyDown(element, { key: ' ' });
  expect(expectSwitchState(container, 'Enabled', true)).toBe(element);
  fireEvent.click(toggle.toggleEl);
  expect(expectSwitchState(container, 'Enabled', false)).toBe(element);
  toggle.setValue(true);
  expect(expectSwitchState(container, 'Enabled', true)).toBe(element);
  setting.setDisabled(true);
  fireEvent.keyDown(element, { key: 'Enter' });
  element.click();
  expect(element.getAttribute('aria-disabled')).toBe('true');
  expect(expectSwitchState(container, 'Enabled', true)).toBe(element);
  setting.setDisabled(false);
  expect(element.getAttribute('aria-disabled')).toBe('false');
  expect(changes).toEqual([false, true, false, true]);
  expect(await axe(container, {
    runOnly: ['aria-toggle-field-name', 'aria-required-attr', 'aria-valid-attr-value', 'aria-allowed-role', 'nested-interactive'],
  })).toHaveNoViolations();
});

it('exposes the restored value after synchronous and asynchronous rollback re-entry', async () => {
  const container = document.body.createDiv();
  let toggle!: ToggleComponent;
  let rejectSave!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  const changes: boolean[] = [];
  new AccessibleSetting(container).setName('Enabled').addToggle(control => {
    toggle = control;
    control.onChange(value => {
      changes.push(value);
      if (value) control.setValue(false);
    });
  });
  const element = expectSwitchState(container, 'Enabled', false);
  fireEvent.keyDown(element, { key: 'Enter' });
  expect(expectSwitchState(container, 'Enabled', false)).toBe(element);
  expect(changes).toEqual([true, false]);

  toggle.onChange(async value => {
    if (!value) return;
    try {
      await pending;
    } finally {
      toggle.setValue(false);
    }
  });
  fireEvent.keyDown(element, { key: ' ' });
  const settled = controlChangeSettled(toggle.toggleEl);
  expect(expectSwitchState(container, 'Enabled', true)).toBe(element);
  rejectSave(new Error('Save failed'));
  await expect(settled).rejects.toThrow('Save failed');
  expect(expectSwitchState(container, 'Enabled', false)).toBe(element);
});

it('exposes section titles as level-two headings without including descriptions', async () => {
  const container = document.body.createDiv();
  new AccessibleSetting(container).setName('Models').setDesc('Select available models').setHeading();
  expect(within(container).getByRole('heading', { name: 'Models', level: 2 })).toBeTruthy();
  expect(await axe(container, {
    runOnly: ['aria-required-attr', 'aria-valid-attr-value', 'empty-heading'],
  })).toHaveNoViolations();
});
