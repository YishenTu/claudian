import type {
  AbstractTextComponent as ObsidianTextComponent,
  BaseComponent,
  ButtonComponent as ObsidianButtonComponent,
  DropdownComponent as ObsidianDropdownComponent,
  Setting as ObsidianSetting,
  SettingDefinitionItem,
  SettingGroup as ObsidianSettingGroup,
  ToggleComponent as ObsidianToggleComponent,
  ValueComponent as ObsidianValueComponent,
} from 'obsidian';

const pendingChanges = new WeakMap<HTMLElement, Promise<void>>();

/** The latest callback for this control or its owning ancestor; retains rejection for explicit assertions. */
export function controlChangeSettled(element: HTMLElement): Promise<void> {
  for (let control: HTMLElement | null = element; control; control = control.parentElement) {
    const pending = pendingChanges.get(control);
    if (pending) return pending;
  }
  return Promise.resolve();
}

function runControlCallback(element: HTMLElement, callback: () => unknown): void {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const pending = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Publish before invocation: setValue inside the callback may start a newer change.
  pendingChanges.set(element, pending);
  void pending.catch(() => undefined);
  try { void Promise.resolve(callback()).then(resolve, reject); }
  catch (error) { reject(error); }
}

abstract class ValueComponent<T> implements ObsidianValueComponent<T> {
  disabled = false;
  then(callback: (component: this) => unknown): this { callback(this); return this; }
  registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string): this {
    listeners[key] = value => { if (value !== undefined) this.setValue(value); return this.getValue(); };
    return this;
  }
  abstract setDisabled(disabled: boolean): this;
  abstract getValue(): T;
  abstract setValue(value: T): this;
}

/** DOM implementation of the Obsidian controls used by settings editors. */
/** Records modal hotkeys; `press` runs the handler registered for a key, as Obsidian's keymap would. */
export class ModalScope {
  private readonly handlers: Array<{ modifiers: string[] | null; key: string | null; func: (evt: KeyboardEvent) => unknown }> = [];
  register(modifiers: string[] | null, key: string | null, func: (evt: KeyboardEvent) => unknown): unknown {
    const handler = { modifiers, key, func };
    this.handlers.push(handler);
    return handler;
  }
  unregister(handler: unknown): void {
    const index = this.handlers.indexOf(handler as never);
    if (index !== -1) this.handlers.splice(index, 1);
  }
  /** Returns whether a handler took the key; one returning false consumes it. */
  press(modifiers: string[], key: string): boolean {
    const handler = this.handlers.find(entry => entry.key === key
      && JSON.stringify([...(entry.modifiers ?? [])].sort()) === JSON.stringify([...modifiers].sort()));
    if (!handler) return false;
    handler.func(new KeyboardEvent('keydown', { key }));
    return true;
  }
}

export class Modal {
  readonly modalEl = document.createElement('div');
  readonly titleEl = this.modalEl.appendChild(document.createElement('div'));
  readonly contentEl = this.modalEl.appendChild(document.createElement('div'));
  readonly scope = new ModalScope();
  constructor(readonly app: unknown) {
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
  }
  setTitle(title: string): void {
    this.modalEl.setAttribute('aria-label', title);
    this.titleEl.textContent = title;
  }
  open(): void { document.body.appendChild(this.modalEl); this.onOpen(); }
  close(): void { this.onClose(); this.modalEl.remove(); }
  onOpen(): void {}
  onClose(): void {}
}

class TextComponent<T extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement>
extends ValueComponent<string> implements ObsidianTextComponent<T> {
  readonly inputEl: T;
  private change: ((value: string) => unknown) | undefined;
  constructor(container: HTMLElement, tag: 'input' | 'textarea' = 'input') {
    super();
    this.inputEl = container.appendChild(document.createElement(tag)) as T;
    if (tag === 'input') this.inputEl.setAttribute('type', 'text');
    this.inputEl.setAttribute('spellcheck', 'false');
    this.inputEl.addEventListener('input', () => this.onChanged());
  }
  setDisabled(value: boolean): this { this.disabled = this.inputEl.disabled = value; return this; }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChanged(): void { if (this.change) runControlCallback(this.inputEl, () => this.change!(this.getValue())); }
  onChange(callback: (value: string) => unknown): this { this.change = callback; return this; }
}

class DropdownComponent extends ValueComponent<string> implements ObsidianDropdownComponent {
  readonly selectEl: HTMLSelectElement;
  private change: ((value: string) => unknown) | undefined;
  private readonly measureOption: HTMLOptionElement;
  constructor(container: HTMLElement) {
    super();
    this.selectEl = container.appendChild(document.createElement('select'));
    this.selectEl.className = 'dropdown';
    const measure = container.appendChild(document.createElement('select'));
    measure.className = 'dropdown is-measuring';
    measure.setAttribute('aria-hidden', 'true');
    measure.tabIndex = -1;
    this.measureOption = measure.appendChild(document.createElement('option'));
    this.selectEl.addEventListener('change', () => {
      this.resizeToFit();
      if (this.change) runControlCallback(this.selectEl, () => this.change!(this.getValue()));
    });
  }
  private resizeToFit(): void {
    const selected = this.selectEl.selectedOptions[0];
    if (selected) this.measureOption.text = selected.text;
  }
  setDisabled(value: boolean): this { this.disabled = this.selectEl.disabled = value; return this; }
  addOption(value: string, label: string): this { this.selectEl.add(new Option(label, value)); return this; }
  addOptions(options: Record<string, string>): this {
    for (const [value, label] of Object.entries(options)) this.addOption(value, label);
    return this;
  }
  getValue(): string { return this.selectEl.value; }
  setValue(value: string): this { this.selectEl.value = value; this.resizeToFit(); return this; }
  onChange(callback: (value: string) => unknown): this {
    this.change = callback;
    return this;
  }
}

class ToggleComponent extends ValueComponent<boolean> implements ObsidianToggleComponent {
  readonly toggleEl: HTMLLabelElement;
  private on = false;
  private change: ((value: boolean) => unknown) | undefined;
  constructor(container: HTMLElement) {
    super();
    this.toggleEl = container.appendChild(document.createElement('label'));
    this.toggleEl.className = 'checkbox-container';
    this.toggleEl.tabIndex = 0;
    const input = this.toggleEl.appendChild(document.createElement('input'));
    input.type = 'checkbox';
    input.tabIndex = -1;
    this.toggleEl.addEventListener('change', () => this.onClick());
    this.toggleEl.addEventListener('keydown', event => {
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.onClick(); }
    });
  }
  setDisabled(value: boolean): this {
    this.disabled = value; this.toggleEl.classList.toggle('is-disabled', value); return this;
  }
  getValue(): boolean { return this.on; }
  setValue(value: boolean): this {
    if (this.on !== value) {
      this.on = value;
      this.toggleEl.classList.toggle('is-enabled', value);
      if (this.change) runControlCallback(this.toggleEl, () => this.change!(value));
    }
    return this;
  }
  setTooltip(value: string): this { this.toggleEl.setAttribute('aria-label', value); return this; }
  onClick(): void { if (!this.disabled) this.setValue(!this.getValue()); }
  onChange(callback: (value: boolean) => unknown): this { this.change = callback; return this; }
}

export class Setting implements ObsidianSetting {
  readonly components: BaseComponent[] = [];
  errorEl: HTMLElement | null = null;
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;
  constructor(container: HTMLElement) {
    this.settingEl = container.appendChild(document.createElement('div'));
    this.settingEl.classList.add('setting-item');
    this.settingEl.tabIndex = -1;
    this.infoEl = this.settingEl.appendChild(document.createElement('div'));
    this.infoEl.className = 'setting-item-info';
    this.nameEl = this.infoEl.appendChild(document.createElement('div'));
    this.nameEl.className = 'setting-item-name';
    this.descEl = this.infoEl.appendChild(document.createElement('div'));
    this.descEl.className = 'setting-item-description';
    this.controlEl = this.settingEl.appendChild(document.createElement('div'));
    this.controlEl.className = 'setting-item-control';
  }
  then(callback: (setting: this) => unknown): this { callback(this); return this; }
  clear(): this { this.controlEl.replaceChildren(); this.components.length = 0; this.errorEl = null; this.settingEl.classList.remove('is-invalid'); return this; }
  setTooltip(value: string): this { this.nameEl.setAttribute('aria-label', value); return this; }
  setDisabled(value: boolean): this {
    this.settingEl.classList.toggle('is-disabled', value);
    for (const control of this.components) control.setDisabled(value);
    return this;
  }
  setErrorMessage(message: string | null): this {
    this.settingEl.classList.toggle('is-invalid', Boolean(message));
    if (!message) { this.errorEl?.remove(); this.errorEl = null; return this; }
    this.errorEl ??= this.controlEl.appendChild(document.createElement('div'));
    this.errorEl.textContent = message;
    return this;
  }
  addComponent<T extends BaseComponent>(callback: (element: HTMLElement) => T): this {
    this.components.push(callback(this.controlEl)); return this;
  }
  addExtraButton(): this { throw new Error('Obsidian fake does not model extra buttons'); }
  addSearch(): this { throw new Error('Obsidian fake does not model search controls'); }
  addMomentFormat(): this { throw new Error('Obsidian fake does not model moment format controls'); }
  addColorPicker(): this { throw new Error('Obsidian fake does not model color pickers'); }
  addProgressBar(): this { throw new Error('Obsidian fake does not model progress bars'); }
  addSlider(): this { throw new Error('Obsidian fake does not model sliders'); }
  setName(value: Parameters<ObsidianSetting['setName']>[0]): this { this.nameEl.replaceChildren(value); return this; }
  setDesc(value: Parameters<ObsidianSetting['setDesc']>[0]): this { this.descEl.replaceChildren(value); return this; }
  setClass(value: string): this { this.settingEl.classList.add(...value.split(' ').filter(Boolean)); return this; }
  setHeading(): this {
    this.settingEl.classList.add('setting-item-heading');
    return this;
  }
  addText(callback: Parameters<ObsidianSetting['addText']>[0]): this {
    const control = new TextComponent(this.controlEl); this.components.push(control); callback(control); return this;
  }
  addTextArea(callback: Parameters<ObsidianSetting['addTextArea']>[0]): this {
    const control = new TextComponent<HTMLTextAreaElement>(this.controlEl, 'textarea');
    this.components.push(control); callback(control); return this;
  }
  addDropdown(callback: Parameters<ObsidianSetting['addDropdown']>[0]): this {
    const control = new DropdownComponent(this.controlEl); this.components.push(control); callback(control); return this;
  }
  addToggle(callback: Parameters<ObsidianSetting['addToggle']>[0]): this {
    const control = new ToggleComponent(this.controlEl); this.components.push(control); callback(control);
    this.settingEl.classList.add('mod-toggle'); return this;
  }
  addButton(callback: Parameters<ObsidianSetting['addButton']>[0]): this {
    const control = new ButtonComponent(this.controlEl); this.components.push(control); callback(control); return this;
  }
}

class ButtonComponent implements ObsidianButtonComponent {
  readonly buttonEl: HTMLButtonElement;
  disabled = false;
  constructor(container: HTMLElement) {
    this.buttonEl = container.appendChild(document.createElement('button'));
  }
  then(callback: (component: this) => unknown): this { callback(this); return this; }
  setDisabled(value: boolean): this { this.disabled = this.buttonEl.disabled = value; return this; }
  setButtonText(value: string): this { this.buttonEl.textContent = value; return this; }
  setCta(): this { this.buttonEl.classList.add('mod-cta'); return this; }
  removeCta(): this { this.buttonEl.classList.remove('mod-cta'); return this; }
  setDestructive(): this { this.buttonEl.classList.add('mod-destructive'); return this; }
  removeDestructive(): this { this.buttonEl.classList.remove('mod-destructive'); return this; }
  setWarning(): this { return this.setDestructive(); }
  setTooltip(value: string): this { this.buttonEl.setAttribute('aria-label', value); return this; }
  setIcon(value: string): this { this.buttonEl.setAttribute('data-icon', value); return this; }
  setClass(value: string): this { this.buttonEl.classList.add(value); return this; }
  onClick(callback: (event: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener('click', event => runControlCallback(this.buttonEl, () => callback(event))); return this;
  }
}

export const Notice = vi.fn();
export const setIcon = vi.fn();

/** Only imperative definition rows are needed by the plugin's declarative tab. */
export function renderSettingDefinitions(container: HTMLElement, definitions: SettingDefinitionItem[]): () => void {
  const cleanups: Array<() => void> = [];
  const group: ObsidianSettingGroup = {
    listEl: container,
    setHeading() { throw new Error('Obsidian fake does not model group headings'); },
    addClass(name) { container.classList.add(name); return this; },
    addSetting(callback) { callback(new Setting(container)); return this; },
    addSearch() { throw new Error('Obsidian fake does not model group search'); },
    addExtraButton() { throw new Error('Obsidian fake does not model group buttons'); },
  };
  for (const definition of definitions) {
    if (definition.visible === false || (typeof definition.visible === 'function' && !definition.visible())) continue;
    if (!('render' in definition) || typeof definition.render !== 'function') {
      throw new Error('Obsidian fake only models imperative setting definitions');
    }
    const setting = new Setting(container).setName(definition.name);
    if (definition.desc) setting.setDesc(definition.desc);
    const cleanup = definition.render(setting, group);
    if (cleanup) cleanups.push(cleanup);
  }
  return () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); };
}
