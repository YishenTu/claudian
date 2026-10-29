HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (name) { return this.classList.contains(name); };
HTMLElement.prototype.setText = function (value) { this.replaceChildren(value); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of [classes].flat()) this.classList.toggle(name, value);
};
HTMLElement.prototype.appendText = function (value) { this.append(value); };

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

class TextComponent<T extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement> {
  readonly inputEl: T;
  constructor(container: HTMLElement, tag: 'input' | 'textarea' = 'input') {
    this.inputEl = container.appendChild(document.createElement(tag)) as T;
  }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener('input', () => callback(this.inputEl.value)); return this;
  }
}

class DropdownComponent {
  readonly selectEl: HTMLSelectElement;
  constructor(container: HTMLElement) { this.selectEl = container.appendChild(document.createElement('select')); }
  addOption(value: string, label: string): this { this.selectEl.add(new Option(label, value)); return this; }
  setValue(value: string): this { this.selectEl.value = value; return this; }
  onChange(callback: (value: string) => void): this {
    this.selectEl.addEventListener('change', () => callback(this.selectEl.value)); return this;
  }
}

export class Setting {
  private readonly element: HTMLElement;
  readonly settingEl: HTMLElement;
  readonly controlEl: HTMLElement;
  constructor(container: HTMLElement) {
    this.element = this.settingEl = this.controlEl = container.appendChild(document.createElement('div'));
  }
  setName(value: string): this { this.element.appendChild(document.createElement('div')).textContent = value; return this; }
  setDesc(value: string): this { this.element.appendChild(document.createElement('div')).textContent = value; return this; }
  setClass(value: string): this { this.element.classList.add(value); return this; }
  addText(callback: (component: TextComponent) => void): this { callback(new TextComponent(this.element)); return this; }
  addTextArea(callback: (component: TextComponent<HTMLTextAreaElement>) => void): this {
    callback(new TextComponent<HTMLTextAreaElement>(this.element, 'textarea')); return this;
  }
  addDropdown(callback: (component: DropdownComponent) => void): this { callback(new DropdownComponent(this.element)); return this; }
  addButton(callback: (component: ButtonComponent) => void): this { callback(new ButtonComponent(this.element)); return this; }
}

class ButtonComponent {
  readonly buttonEl: HTMLButtonElement;
  constructor(container: HTMLElement) {
    this.buttonEl = container.appendChild(document.createElement('button'));
    this.buttonEl.type = 'button';
  }
  setButtonText(value: string): this { this.buttonEl.textContent = value; return this; }
  setCta(): this { return this; }
  setDestructive(): this { return this; }
  onClick(callback: () => void): this { this.buttonEl.addEventListener('click', callback); return this; }
}

export const Notice = vi.fn();
export const setIcon = vi.fn();
