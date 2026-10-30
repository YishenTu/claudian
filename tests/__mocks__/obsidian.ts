import { Events } from '@test/helpers/ObsidianEvents';
import { createObsidianWorkspace } from '@test/helpers/ObsidianWorkspace';
import type {
  AbstractTextComponent as ObsidianTextComponent,
  BaseComponent,
  ButtonComponent as ObsidianButtonComponent,
  DropdownComponent as ObsidianDropdownComponent,
  Setting as ObsidianSetting,
  SettingGroup as ObsidianSettingGroup,
  ToggleComponent as ObsidianToggleComponent,
  ValueComponent as ObsidianValueComponent,
} from 'obsidian';
import type { MarkdownRenderer as ObsidianMarkdownRenderer, SettingDefinitionItem } from 'obsidian';
import { parse as parseYAML } from 'yaml';

export { Events };

// Pane selection is an Obsidian boundary; callers can provide its native decision.
export const Keymap = { isModEvent: vi.fn((_event?: unknown): boolean | 'tab' | 'split' | 'window' => false) };

// Mock for Obsidian API

// Match Obsidian's explicit load/unload lifecycle; DOM removal alone does not unload children.
export class Component {
  private loaded = false;
  private children: Component[] = [];
  private cleanups: (() => void)[] = [];

  load(): void | Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const loading = [this.onload(), ...this.children.slice().map(child => child.load())]
      .filter(result => result !== undefined);
    if (loading.length) return Promise.all(loading).then(() => {});
  }

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    while (this.children.length) this.children.pop()!.unload();
    while (this.cleanups.length) this.cleanups.pop()!();
    this.onunload();
  }

  onload(): void | Promise<void> {}
  onunload(): void {}

  addChild<T extends Component>(child: T): T {
    this.children.push(child);
    if (this.loaded) child.load();
    return child;
  }

  removeChild<T extends Component>(child: T): T {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.unload();
    }
    return child;
  }

  register(callback: () => void): void {
    this.cleanups.push(callback);
  }

  registerEvent(ref: import('obsidian').EventRef): void {
    if (!('e' in ref) || !(ref.e instanceof Events)) throw new Error('Expected an Obsidian Events reference');
    const owner = ref.e;
    this.register(() => owner.offref(ref));
  }

  registerDomEvent<K extends keyof HTMLElementEventMap>(element: HTMLElement, type: K, callback: (event: HTMLElementEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent<K extends keyof DocumentEventMap>(element: Document, type: K, callback: (event: DocumentEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent<K extends keyof WindowEventMap>(element: Window, type: K, callback: (event: WindowEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  registerDomEvent(element: EventTarget, type: string, callback: EventListener, options?: boolean | AddEventListenerOptions): void {
    element.addEventListener(type, callback, options);
    this.register(() => element.removeEventListener(type, callback, options));
  }

  registerInterval(id: number): number {
    this.register(() => clearInterval(id));
    return id;
  }
}

export class Plugin {
  app: any;
  manifest: any;

  constructor(app?: any, manifest?: any) {
    this.app = app;
    this.manifest = manifest;
  }

  addRibbonIcon = vi.fn();
  addCommand = vi.fn();
  addSettingTab = vi.fn();
  registerView = vi.fn();
  registerEvent = vi.fn();
  loadData = vi.fn().mockResolvedValue({});
  saveData = vi.fn().mockResolvedValue(undefined);
}

export class PluginSettingTab {
  app: any;
  plugin: any;
  settingItems: SettingDefinitionItem[] = [];
  private cleanup: (() => void) | undefined;
  private container: HTMLElement | undefined;
  get containerEl(): HTMLElement { return this.container ??= hostDocument().createElement('div'); }
  set containerEl(element: HTMLElement) { this.container = element; }

  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  update(): void {
    this.settingItems = this.getSettingDefinitions();
    this.hide();
    this.cleanup = renderSettingDefinitions(this.containerEl, this.settingItems);
  }

  hide(): void {
    this.cleanup?.();
    this.cleanup = undefined;
    this.container?.replaceChildren();
  }
}

export class View extends Component {
  app: any = { workspace: { on: vi.fn(), offref: vi.fn() } };
  leaf: any;
  private container: HTMLElement | undefined;
  get containerEl(): HTMLElement {
    return this.container ??= this.createContainer();
  }
  set containerEl(element: HTMLElement) { this.container = element; }

  protected createContainer(): HTMLElement {
    const container = hostDocument().createElement('div');
    container.className = 'workspace-leaf-content';
    return container;
  }

  constructor(leaf: any) {
    super();
    this.leaf = leaf;
    if (leaf?.app) this.app = leaf.app;
  }

  getViewType(): string {
    return '';
  }

  getDisplayText(): string {
    return '';
  }

  getIcon(): string {
    return '';
  }
}

export class ItemView extends View {
  override load(): void {
    // Obsidian's ItemView starts Component loading but does not return its join promise.
    super.load();
  }

  private content: HTMLElement | undefined;
  private header: HTMLElement | undefined;
  get contentEl(): HTMLElement { return this.content ?? this.containerEl.children[1] as HTMLElement; }
  set contentEl(element: HTMLElement) { this.content = element; }
  get headerEl(): HTMLElement { return this.header ?? this.containerEl.children[0] as HTMLElement; }
  set headerEl(element: HTMLElement) { this.header = element; }

  protected override createContainer(): HTMLElement {
    const container = super.createContainer();
    container.createDiv('view-header');
    container.createDiv('view-content');
    return container;
  }
}

export class FileView extends ItemView {
  allowNoFile = false;
  file: any = null;
  navigation = true;
}

export class TextFileView extends FileView {
  data = '';

  getViewData(): string {
    return this.data;
  }
}

export class WorkspaceLeaf {}

export class Scope {
  static instances: Scope[] = [];

  parent?: Scope;
  handlers: Array<{
    modifiers: string[] | null;
    key: string | null;
    func: (evt: KeyboardEvent, ctx?: unknown) => false | unknown;
  }> = [];

  constructor(parent?: Scope) {
    this.parent = parent;
    Scope.instances.push(this);
  }

  register = vi.fn((
    modifiers: string[] | null,
    key: string | null,
    func: (evt: KeyboardEvent, ctx?: unknown) => false | unknown
  ) => {
    const handler = { modifiers, key, func };
    this.handlers.push(handler);
    return handler;
  });

  unregister = vi.fn((handler: unknown) => {
    this.handlers = this.handlers.filter((entry) => entry !== handler);
  });

  /** Dispatch a host keymap event explicitly; this does not simulate browser focus or key defaults. */
  press(modifiers: string[], key: string): boolean {
    const handler = this.handlers.find(entry => entry.key === key
      && (entry.modifiers === null || JSON.stringify([...entry.modifiers].sort()) === JSON.stringify([...modifiers].sort())));
    if (!handler) return this.parent?.press(modifiers, key) ?? false;
    handler.func(new KeyboardEvent('keydown', { key, cancelable: true }));
    return true;
  }
}

export const Platform = {
  isMacOS: true,
  resourcePathPrefix: 'app://local/',
};

export class Vault extends Events {
  adapter = { basePath: '/mock/vault/path' };
  getAllLoadedFiles(): Array<TFile | TFolder> { return []; }
  getFiles(): TFile[] { return this.getAllLoadedFiles().filter((file): file is TFile => file instanceof TFile); }
  getMarkdownFiles(): TFile[] { return this.getFiles().filter(file => file.extension === 'md'); }
  getAbstractFileByPath(path: string): TFile | TFolder | null {
    return this.getAllLoadedFiles().find(file => file.path === path) ?? null;
  }
}

export class MetadataCache extends Events {
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  getFileCache(_file: TFile): import('obsidian').CachedMetadata | null { return null; }
  getFirstLinkpathDest(_linkpath: string, _sourcePath: string): TFile | null { return null; }
}

export class App {
  metadataCache = new MetadataCache();
  // Scope ownership is observable; native keyboard routing remains outside jsdom.
  keymap = {
    pushScope: vi.fn((_scope: Scope) => {}),
    popScope: vi.fn((_scope: Scope) => {}),
  };
  vault = new Vault();
  workspace: any = {
    // Obsidian always mounts the workspace container; DOM suites get one with real events.
    ...createObsidianWorkspace(typeof document === 'undefined' ? undefined : hostDocument().createElement('div')),
    getActiveFile: (): TFile | null => null,
    getLeavesOfType: vi.fn().mockReturnValue([]),
    getRightLeaf: vi.fn().mockReturnValue({
      setViewState: vi.fn().mockResolvedValue(undefined),
    }),
    getLeftLeaf: vi.fn().mockReturnValue({
      setViewState: vi.fn().mockResolvedValue(undefined),
    }),
    getLeaf: vi.fn().mockReturnValue({
      setViewState: vi.fn().mockResolvedValue(undefined),
    }),
    setActiveLeaf: vi.fn(),
    revealLeaf: vi.fn(),
  };
}

export class MarkdownView {
  editor: any;
  file?: any;
  containerEl: HTMLElement;

  constructor(editor?: any, file?: any) {
    this.editor = editor;
    this.file = file;
    this.containerEl = typeof document === 'undefined' ? undefined! : hostDocument().createElement('div');
  }

  // The host's current mode is source or preview. Tests can select preview through this public port.
  getMode(): 'source' | 'preview' { return 'source'; }
}

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

export class TextComponent<T extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement>
extends ValueComponent<string> implements ObsidianTextComponent<T> {
  readonly inputEl: T;
  private change: ((value: string) => unknown) | undefined;
  constructor(container: HTMLElement, tag: 'input' | 'textarea' = 'input') {
    super();
    this.inputEl = container.appendChild(hostDocument().createElement(tag)) as T;
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

export class DropdownComponent extends ValueComponent<string> implements ObsidianDropdownComponent {
  readonly selectEl: HTMLSelectElement;
  private change: ((value: string) => unknown) | undefined;
  private readonly measureOption: HTMLOptionElement;
  constructor(container: HTMLElement) {
    super();
    this.selectEl = container.appendChild(hostDocument().createElement('select'));
    this.selectEl.className = 'dropdown';
    const measure = container.appendChild(hostDocument().createElement('select'));
    measure.className = 'dropdown is-measuring';
    measure.setAttribute('aria-hidden', 'true');
    measure.tabIndex = -1;
    this.measureOption = measure.appendChild(hostDocument().createElement('option'));
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

export class ToggleComponent extends ValueComponent<boolean> implements ObsidianToggleComponent {
  readonly toggleEl: HTMLLabelElement;
  private on = false;
  private change: ((value: boolean) => unknown) | undefined;
  constructor(container: HTMLElement) {
    super();
    this.toggleEl = container.appendChild(hostDocument().createElement('label'));
    this.toggleEl.className = 'checkbox-container';
    this.toggleEl.tabIndex = 0;
    const input = this.toggleEl.appendChild(hostDocument().createElement('input'));
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
    this.settingEl = container.appendChild(hostDocument().createElement('div'));
    this.settingEl.classList.add('setting-item');
    this.settingEl.tabIndex = -1;
    this.infoEl = this.settingEl.appendChild(hostDocument().createElement('div'));
    this.infoEl.className = 'setting-item-info';
    this.nameEl = this.infoEl.appendChild(hostDocument().createElement('div'));
    this.nameEl.className = 'setting-item-name';
    this.descEl = this.infoEl.appendChild(hostDocument().createElement('div'));
    this.descEl.className = 'setting-item-description';
    this.controlEl = this.settingEl.appendChild(hostDocument().createElement('div'));
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
    this.errorEl ??= this.controlEl.appendChild(hostDocument().createElement('div'));
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

export class ButtonComponent implements ObsidianButtonComponent {
  readonly buttonEl: HTMLButtonElement;
  disabled = false;
  constructor(container: HTMLElement) {
    this.buttonEl = container.appendChild(hostDocument().createElement('button'));
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
  setIcon(value: string): this { setIcon(this.buttonEl, value); return this; }
  setClass(value: string): this { this.buttonEl.classList.add(value); return this; }
  onClick(callback: (event: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener('click', event => runControlCallback(this.buttonEl, () => callback(event))); return this;
  }
}


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

class MockMenuItem {
  title = '';
  icon = '';
  disabled = false;
  checked: boolean | null = null;
  isLabel = false;
  clickHandler: (() => void) | null = null;

  setTitle = vi.fn((title: string) => {
    this.title = title;
    return this;
  });

  setIcon = vi.fn((icon: string) => {
    this.icon = icon;
    return this;
  });

  setDisabled = vi.fn((disabled: boolean) => {
    this.disabled = disabled;
    return this;
  });

  setChecked = vi.fn((checked: boolean | null) => {
    this.checked = checked;
    return this;
  });

  setIsLabel = vi.fn((isLabel: boolean) => {
    this.isLabel = isLabel;
    return this;
  });

  setWarning = vi.fn((_isWarning: boolean) => this);

  onClick = vi.fn((handler: () => void) => {
    this.clickHandler = handler;
    return this;
  });
}

export class Menu {
  static instances: Menu[] = [];

  items: MockMenuItem[] = [];
  useNativeMenu: boolean | null = null;
  showAtMouseEvent = vi.fn();
  showAtPosition = vi.fn();

  constructor() {
    Menu.instances.push(this);
  }

  addItem(callback: (item: MockMenuItem) => MockMenuItem | void): this {
    const item = new MockMenuItem();
    callback(item);
    this.items.push(item);
    return this;
  }

  addSeparator(): this {
    return this;
  }

  setUseNativeMenu = vi.fn((useNativeMenu: boolean) => {
    this.useNativeMenu = useNativeMenu;
    return this;
  });

  private hideCallbacks: Array<() => void> = [];

  onHide = vi.fn((callback: () => void) => {
    this.hideCallbacks.push(callback);
  });

  /** Runs the hide callbacks once, as Obsidian does when a shown menu closes. */
  hide = vi.fn(() => {
    for (const callback of this.hideCallbacks.splice(0)) callback();
    return this;
  });
}

const renderMarkdownMock = vi.fn<typeof ObsidianMarkdownRenderer.renderMarkdown>(async (markdown, element) => {
  element.textContent = markdown;
});


export const MarkdownRenderer = {
  render: vi.fn<typeof ObsidianMarkdownRenderer.render>(
    (_app, markdown, el, sourcePath, component) => renderMarkdownMock(markdown, el, sourcePath, component),
  ),
  renderMarkdown: renderMarkdownMock,
};

export const loadMermaid = vi.fn();

export const loadPrism = vi.fn().mockResolvedValue({
  highlightElement: vi.fn(),
});

export const setIcon = vi.fn((_element: HTMLElement, _iconId: string) => {});

// Notice mock that tracks constructor calls
export const Notice = vi.fn().mockImplementation(function (_message: string, _timeout?: number) {});

// Obsidian 1.13.7 app.js yL delegates to YAML.parse(source, null, {}),
// with ordinary errors enabled. The installed yaml public-api implementation matches wT.
export function parseYaml(content: string): unknown {
  return parseYAML(content, {});
}

/** Obsidian app.js _T: strict opening delimiter, line-start closing delimiter, original offsets. */
export function getFrontMatterInfo(content: string): import('obsidian').FrontMatterInfo {
  const missing = { exists: false, contentStart: 0, from: 0, to: 0, frontmatter: '' };
  const opening = /^---(\r?\n)/.exec(content);
  if (!opening) return missing;
  const from = opening[0].length;
  const closing = /---(\r?\n|$)/g;
  closing.lastIndex = from;
  let match = closing.exec(content);
  while (match && content.charAt(match.index - 1) !== '\n') match = closing.exec(content);
  if (!match) return missing;
  return { exists: true, frontmatter: content.slice(from, match.index), from, to: match.index, contentStart: closing.lastIndex };
}

// TFile class for instanceof checks
export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;

  constructor(path: string = '') {
    this.path = path;
    this.name = path.split('/').pop() || '';
    this.basename = this.name.replace(/\.[^.]+$/, '');
    this.extension = this.name.split('.').pop() || '';
  }
}

export class TFolder {
  path: string;
  name: string;
  children: any[] = [];

  constructor(path: string = '') {
    this.path = path;
    this.name = path.split('/').pop() || '';
  }
}

// The host serializer is optional; retain the existing fallback exercised by tests.
export const stringifyYaml = undefined;


/** DOM use is explicit; importing the host or constructing non-DOM services remains Node-safe. */
function hostDocument(): Document {
  if (typeof document === 'undefined') throw new Error('Obsidian DOM controls require a jsdom test environment');
  return document;
}

export { Scope as ModalScope };

let activeDocument: Document | undefined;

/** Selects the Obsidian active-window boundary without replacing Modal or its lifecycle. */
export function setObsidianActiveDocument(document?: Document): void {
  activeDocument = document;
}

export class Modal {
  private container: HTMLDivElement | undefined;
  private modal: HTMLDivElement | undefined;
  private title: HTMLDivElement | undefined;
  private content: HTMLDivElement | undefined;
  readonly scope = new Scope();
  private closeCallback: (() => void) | undefined;
  constructor(readonly app: App) {
    this.scope.register([], 'Escape', event => {
      if (!event.defaultPrevented) { event.preventDefault(); this.close(); }
    });
  }
  // Obsidian 1.13.7 app.js fw: these are plain divs; setTitle adds no ARIA.
  get containerEl(): HTMLDivElement {
    if (!this.container) {
      this.container = hostDocument().createElement('div');
      this.container.className = 'modal-container';
      this.container.createDiv('modal-bg');
      const modal = this.modal = this.container.createDiv('modal');
      modal.createDiv('modal-header-button mod-raised clickable-icon').addEventListener('click', () => this.close());
      this.title = modal.createDiv('modal-header').createDiv('modal-title');
      this.content = modal.createDiv('modal-content');
    }
    return this.container;
  }
  get modalEl(): HTMLDivElement { if (!this.modal) void this.containerEl; return this.modal!; }
  get titleEl(): HTMLDivElement { if (!this.title) void this.containerEl; return this.title!; }
  get contentEl(): HTMLDivElement { if (!this.content) void this.containerEl; return this.content!; }
  setTitle(title: string): this { this.titleEl.textContent = title; return this; }
  setContent(content: string | DocumentFragment): this {
    if (typeof content === 'string') this.contentEl.textContent = content;
    else this.contentEl.appendChild(content);
    return this;
  }
  setCloseCallback(callback: () => void): this { this.closeCallback = callback; return this; }
  open(): void {
    if (this.containerEl.parentNode) return;
    this.app.keymap.pushScope(this.scope);
    (activeDocument ?? hostDocument()).body.appendChild(this.containerEl);
    this.onOpen();
  }
  close(): void {
    this.app.keymap.popScope(this.scope);
    this.container?.remove();
    this.onClose();
    this.closeCallback?.();
  }
  onOpen(): void {}
  onClose(): void {}
}
