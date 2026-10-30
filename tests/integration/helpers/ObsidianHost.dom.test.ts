/** @vitest-environment jsdom */
import { controlChangeSettled, setObsidianActiveDocument } from '@test/helpers/ObsidianHost';
import { fireEvent, within } from '@testing-library/dom';
import { App, ItemView, Modal, Setting, type ToggleComponent, WorkspaceLeaf } from 'obsidian';

afterEach(() => { document.body.replaceChildren(); });

// Obsidian 1.13.7 obsidian.asar/app.js: Setting (Yb) creates div.setting-item
// with info/name/description/control divs; addToggle (nw) creates a tabindex=0
// label.checkbox-container holding input[type=checkbox][tabindex=-1]. Neither
// add* nor setHeading supplies roles or label associations. Dropdown (cw) also
// creates an aria-hidden measuring select. These assertions pin that host shape.
it('matches the host structure without inventing control names or heading roles', () => {
  let toggle!: ToggleComponent;
  const setting = new Setting(document.body).setName('Visible title').setDesc('Description')
    .addText(() => {}).addTextArea(() => {}).addDropdown(control => control.addOption('one', 'One'))
    .addToggle(control => { toggle = control; }).setHeading();
  expect(setting.settingEl.outerHTML).toBe(
    '<div class="setting-item mod-toggle setting-item-heading" tabindex="-1">'
    + '<div class="setting-item-info"><div class="setting-item-name">Visible title</div>'
    + '<div class="setting-item-description">Description</div></div>'
    + '<div class="setting-item-control"><input type="text" spellcheck="false">'
    + '<textarea spellcheck="false"></textarea><select class="dropdown"><option value="one">One</option></select>'
    + '<select class="dropdown is-measuring" aria-hidden="true" tabindex="-1"><option></option></select>'
    + '<label class="checkbox-container" tabindex="0"><input type="checkbox" tabindex="-1"></label></div></div>',
  );
  expect(toggle.toggleEl.tagName).toBe('LABEL');
  expect(within(setting.settingEl).queryByRole('heading')).toBeNull();
  expect(within(setting.settingEl).queryByRole('switch')).toBeNull();
  expect(within(setting.settingEl).getByRole('checkbox', { name: '' })).toBe(toggle.toggleEl.firstElementChild);
  const [text, textarea] = within(setting.settingEl).getAllByRole('textbox', { name: '' });
  text.setAttribute('aria-label', 'Explicit text name');
  setting.nameEl.id = 'caller-title';
  textarea.setAttribute('aria-labelledby', 'caller-title');
  expect(within(setting.settingEl).getByRole('textbox', { name: 'Explicit text name' })).toBe(text);
  expect(within(setting.settingEl).getByRole('textbox', { name: 'Visible title' })).toBe(textarea);
  expect(text.hasAttribute('aria-labelledby')).toBe(false);
});

it('uses one changed-value transition for programmatic, pointer and keyboard activation', async () => {
  let toggle!: ToggleComponent;
  const changed = vi.fn();
  new Setting(document.body).addToggle(control => { toggle = control.onChange(changed); });
  toggle.setValue(true);
  // app.js setValue updates .is-enabled, not the nested checkbox property.
  expect(toggle.toggleEl.querySelector('input')!.checked).toBe(false);
  toggle.setValue(true).setValue(false);
  await controlChangeSettled(toggle.toggleEl);
  expect(changed.mock.calls).toEqual([[true], [false]]);
  fireEvent.click(toggle.toggleEl);
  fireEvent.keyDown(toggle.toggleEl, { key: 'Enter' });
  fireEvent.keyDown(toggle.toggleEl, { key: ' ' });
  await controlChangeSettled(toggle.toggleEl);
  expect(changed.mock.calls).toEqual([[true], [false], [true], [false], [true]]);
  expect(toggle.getValue()).toBe(true);
  expect(toggle.toggleEl.classList.contains('is-enabled')).toBe(true);
  toggle.setDisabled(true);
  fireEvent.click(toggle.toggleEl);
  fireEvent.keyDown(toggle.toggleEl, { key: 'Enter' });
  expect(changed).toHaveBeenCalledTimes(5);
  expect(toggle.toggleEl.classList.contains('is-disabled')).toBe(true);
});

it('waits for the latest callback on each control without swallowing its rejection', async () => {
  let finishFirst!: () => void;
  let failSecond!: (error: Error) => void;
  const first = new Promise<void>(resolve => { finishFirst = resolve; });
  const second = new Promise<void>((_resolve, reject) => { failSecond = reject; });
  const change = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  new Setting(document.body).setName('Provider').addToggle(control => { control.onChange(change); });
  const input = within(document.body).getByRole('checkbox', { name: '' });
  fireEvent.click(input);
  const previous = controlChangeSettled(input);
  fireEvent.click(input);
  const latest = controlChangeSettled(input);
  expect(latest).not.toBe(previous);
  finishFirst();
  await previous;
  let settled = false;
  void latest.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  failSecond(new Error('Commit failed'));
  await expect(latest).rejects.toThrow('Commit failed');
  await expect(controlChangeSettled(input)).rejects.toThrow('Commit failed');
});

it('captures synchronous faults and tracks text, dropdown and button callbacks separately', async () => {
  new Setting(document.body).setName('Name').addText(control => control.onChange(() => { throw new Error('Invalid name'); }));
  new Setting(document.body).setName('Model').addDropdown(control => control.addOption('one', 'One').onChange(async () => {}));
  new Setting(document.body).addButton(control => control.setButtonText('Save').onClick(async () => {}));
  const text = within(document.body).getByRole('textbox', { name: '' });
  const select = within(document.body).getByRole('combobox', { name: '' });
  const button = within(document.body).getByRole('button', { name: 'Save' });
  fireEvent.input(text, { target: { value: 'New' } });
  // Let the rejection pass a turn before observing it: the helper must handle it internally.
  await new Promise(resolve => setImmediate(resolve));
  await expect(controlChangeSettled(text)).rejects.toThrow('Invalid name');
  fireEvent.change(select, { target: { value: 'one' } });
  fireEvent.click(button);
  await expect(controlChangeSettled(select)).resolves.toBeUndefined();
  await expect(controlChangeSettled(button)).resolves.toBeUndefined();
});

it('installs Obsidian element helpers and honors the native input type option', () => {
  const container = document.body.createDiv();
  const input = container.createEl('input', { type: 'checkbox', value: 'chosen' });
  expect(input.type).toBe('checkbox');
  expect(input.value).toBe('chosen');
  container.addClass('active');
  container.toggleClass(['active', 'pending'], false);
  expect(container.hasClass('active')).toBe(false);
  container.setText('Text');
  container.appendText(' appended');
  expect(container.textContent).toBe('Text appended');
  container.empty();
  expect(container.childNodes).toHaveLength(0);
});

it('keeps a synchronous reentrant callback as the latest observable rejection', async () => {
  let toggle!: ToggleComponent;
  let outer!: Promise<void>;
  new Setting(document.body).addToggle(control => {
    toggle = control.onChange(value => {
      if (value) {
        outer = controlChangeSettled(control.toggleEl);
        control.setValue(false);
        throw new Error('Outer failure');
      }
      throw new Error('Reentrant failure');
    });
  });
  toggle.setValue(true);
  await expect(outer).rejects.toThrow('Outer failure');
  await expect(controlChangeSettled(toggle.toggleEl)).rejects.toThrow('Reentrant failure');
});

it('observes a native toggle input through pending change, rollback re-entry and rejection', async () => {
  const values: boolean[] = [];
  let releaseChange!: () => void;
  const changing = new Promise<void>(resolve => { releaseChange = resolve; });
  let toggle!: ToggleComponent;
  new Setting(document.body).addToggle(control => {
    toggle = control.setValue(true).onChange(async value => {
      values.push(value);
      if (!value) {
        await changing;
        control.setValue(true);
        throw new Error('Requested change failure');
      }
      throw new Error('Rollback callback failure');
    });
  });
  const input = within(document.body).getByRole('checkbox', { name: '' });
  fireEvent.click(input);
  const requested = controlChangeSettled(input);
  expect(requested).toBe(controlChangeSettled(toggle.toggleEl));
  expect(values).toEqual([false]);
  releaseChange();
  await expect(requested).rejects.toThrow('Requested change failure');
  const rollback = controlChangeSettled(input);
  expect(rollback).not.toBe(requested);
  expect(rollback).toBe(controlChangeSettled(toggle.toggleEl));
  await expect(rollback).rejects.toThrow('Rollback callback failure');
  expect(values).toEqual([false, true]);
  expect(toggle.getValue()).toBe(true);
});

// Obsidian 1.13.7 app.js fw: modal-container > modal-bg + modal;
// modal contains the close control, modal-header > modal-title, and modal-content.
// setTitle changes text only; open is idempotent and close detaches before onClose.
it('uses the default host modal structure and lifecycle without fabricated ARIA', () => {
  const events: Array<{ action: string; connected: boolean }> = [];
  class TestModal extends Modal {
    onOpen(): void { events.push({ action: 'open', connected: this.containerEl.isConnected }); }
    onClose(): void { events.push({ action: 'close', connected: this.containerEl.isConnected }); }
  }
  const app = new App();
  const modal = new TestModal(app);
  vi.mocked(app.keymap.pushScope).mockImplementation(() => {
    events.push({ action: 'push', connected: modal.containerEl.isConnected });
  });
  vi.mocked(app.keymap.popScope).mockImplementation(() => {
    events.push({ action: 'pop', connected: modal.containerEl.isConnected });
  });
  modal.setTitle('Host modal');
  expect(modal.containerEl.className).toBe('modal-container');
  expect(modal.modalEl.className).toBe('modal');
  expect(modal.contentEl.className).toBe('modal-content');
  expect(modal.titleEl.parentElement?.className).toBe('modal-header');
  expect(modal.titleEl.textContent).toBe('Host modal');
  expect(modal.containerEl.querySelector('[role], [aria-modal], [aria-label]')).toBeNull();
  const popout = document.implementation.createHTMLDocument('Popout');
  setObsidianActiveDocument(popout);
  try {
    modal.open();
    expect(modal.containerEl.ownerDocument).toBe(popout);
  } finally {
    setObsidianActiveDocument();
  }
  modal.open();
  expect(events).toEqual([{ action: 'push', connected: false }, { action: 'open', connected: true }]);
  expect(app.keymap.pushScope).toHaveBeenCalledExactlyOnceWith(modal.scope);
  modal.close();
  expect(events).toEqual([
    { action: 'push', connected: false }, { action: 'open', connected: true },
    { action: 'pop', connected: true }, { action: 'close', connected: false },
  ]);
  expect(app.keymap.popScope).toHaveBeenCalledExactlyOnceWith(modal.scope);
});

it('provides writable host view elements with real DOM defaults', () => {
  class TestView extends ItemView {
    getViewType(): string { return 'test'; }
    getDisplayText(): string { return 'Test'; }
  }
  const view = new TestView(new WorkspaceLeaf());
  expect(view.contentEl.className).toBe('view-content');
  const replacement = document.createElement('section');
  view.contentEl = replacement;
  expect(view.contentEl).toBe(replacement);
});
