HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.setText = function (value) { this.replaceChildren(value); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of [classes].flat()) this.classList.toggle(name, value);
};
HTMLElement.prototype.appendText = function (value) { this.append(value); };

/** DOM implementation of the Obsidian controls used by settings editors. */
export class Modal {
  readonly modalEl = document.createElement('div');
  readonly contentEl = this.modalEl.appendChild(document.createElement('div'));
  constructor(_app: unknown) {
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
  }
  setTitle(title: string): void { this.modalEl.setAttribute('aria-label', title); }
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
}

export const Notice = jest.fn();
export const setIcon = jest.fn();
