HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.setText = function (value) { this.replaceChildren(value); };

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

class TextComponent {
  readonly inputEl: HTMLInputElement;
  constructor(container: HTMLElement) { this.inputEl = container.appendChild(document.createElement('input')); }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
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
  constructor(container: HTMLElement) { this.element = container.appendChild(document.createElement('div')); }
  setName(value: string): this { this.element.appendChild(document.createElement('div')).textContent = value; return this; }
  setDesc(value: string): this { this.element.appendChild(document.createElement('div')).textContent = value; return this; }
  addText(callback: (component: TextComponent) => void): this { callback(new TextComponent(this.element)); return this; }
  addDropdown(callback: (component: DropdownComponent) => void): this { callback(new DropdownComponent(this.element)); return this; }
}

export const Notice = jest.fn();
export const setIcon = jest.fn();
