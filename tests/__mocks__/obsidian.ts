// Pane selection is an Obsidian boundary; callers can provide its native decision.
export const Keymap = { isModEvent: vi.fn((_event?: unknown): boolean | 'tab' | 'split' | 'window' => false) };

// Mock for Obsidian API

// Match Obsidian's explicit load/unload lifecycle; DOM removal alone does not unload children.
export class Component {
  private loaded = false;
  private children: Component[] = [];
  private cleanups: (() => void)[] = [];

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
    for (const child of this.children.slice()) child.load();
  }

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    while (this.children.length) this.children.pop()!.unload();
    while (this.cleanups.length) this.cleanups.pop()!();
    this.onunload();
  }

  onload(): void {}
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
  settingItems: any[] = [];
  containerEl: any = {
    empty: vi.fn(),
    createEl: vi.fn().mockReturnValue({ createEl: vi.fn(), createDiv: vi.fn() }),
    createDiv: vi.fn().mockReturnValue({ createEl: vi.fn(), createDiv: vi.fn() }),
  };

  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }

  getSettingDefinitions(): any[] {
    return [];
  }

  update() {
    this.settingItems = this.getSettingDefinitions();
  }
}

export class ItemView {
  app: any = { workspace: { on: vi.fn(), offref: vi.fn() } };
  leaf: any;
  containerEl: any = {
    isShown: () => true,
    children: [{}, { empty: vi.fn(), addClass: vi.fn(), createDiv: vi.fn().mockReturnValue({
      createEl: vi.fn().mockReturnValue({ addEventListener: vi.fn(), setAttribute: vi.fn() }),
      createDiv: vi.fn().mockReturnValue({ createEl: vi.fn().mockReturnValue({ addEventListener: vi.fn() }) }),
    }) }],
  };

  constructor(leaf: any) {
    this.leaf = leaf;
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
}

export const Platform = {
  isMacOS: true,
  resourcePathPrefix: 'app://local/',
};

export class App {
  vault: any = {
    adapter: {
      basePath: '/mock/vault/path',
    },
  };
  workspace: any = {
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

  constructor(editor?: any, file?: any) {
    this.editor = editor;
    this.file = file;
  }
}

export class Setting {
  constructor(_containerEl: any) {}
  setName = vi.fn().mockReturnThis();
  setDesc = vi.fn().mockReturnThis();
  addToggle = vi.fn().mockReturnThis();
  addTextArea = vi.fn().mockReturnThis();
}

export class Modal {
  app: any;
  containerEl: any = {
    createDiv: vi.fn().mockReturnValue({
      createEl: vi.fn().mockReturnValue({ addEventListener: vi.fn() }),
      createDiv: vi.fn().mockReturnValue({
        createEl: vi.fn().mockReturnValue({ addEventListener: vi.fn() }),
        createDiv: vi.fn().mockReturnValue({
          createEl: vi.fn(),
        }),
        setText: vi.fn(),
      }),
      addClass: vi.fn(),
      setText: vi.fn(),
    }),
    empty: vi.fn(),
    addClass: vi.fn(),
  };
  contentEl: any = {
    createDiv: vi.fn().mockReturnValue({
      createEl: vi.fn().mockReturnValue({ addEventListener: vi.fn() }),
      createDiv: vi.fn().mockReturnValue({
        createEl: vi.fn().mockReturnValue({ addEventListener: vi.fn() }),
        createDiv: vi.fn().mockReturnValue({
          createEl: vi.fn(),
        }),
        setText: vi.fn(),
      }),
      addClass: vi.fn(),
      setText: vi.fn(),
    }),
    empty: vi.fn(),
    addClass: vi.fn(),
  };

  constructor(app: any) {
    this.app = app;
  }

  open = vi.fn();
  close = vi.fn();
  onOpen = vi.fn();
  onClose = vi.fn();
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

const renderMarkdownMock = vi.fn<(...args: [string, unknown, string, unknown]) => Promise<void>>().mockResolvedValue(undefined);

export const MarkdownRenderer = {
  render: vi.fn<(...args: [unknown, string, unknown, string, unknown]) => Promise<void>>(
    (_app, markdown, el, sourcePath, component) => renderMarkdownMock(markdown, el, sourcePath, component),
  ),
  renderMarkdown: renderMarkdownMock,
};

export const loadMermaid = vi.fn();

export const loadPrism = vi.fn().mockResolvedValue({
  highlightElement: vi.fn(),
});

export const setIcon = vi.fn();

// Notice mock that tracks constructor calls
export const Notice = vi.fn().mockImplementation(function (_message: string, _timeout?: number) {});

function unquoteYaml(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseYamlValue(rawValue: string): unknown {
  if (!rawValue) return null;

  if (rawValue.startsWith('{') && rawValue.endsWith('}')) {
    try { return JSON.parse(rawValue); } catch { /* fall through */ }
  }

  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    return rawValue.slice(1, -1).split(',').map(item => unquoteYaml(item.trim())).filter(Boolean);
  }

  if (rawValue === 'true' || rawValue === 'false') {
    return rawValue === 'true';
  }

  const numberValue = Number(rawValue);
  if (!Number.isNaN(numberValue) && rawValue !== '') {
    return numberValue;
  }

  return unquoteYaml(rawValue);
}

export function parseYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let currentArrayKey: string | null = null;
  let currentArray: string[] = [];
  let blockScalarKey: string | null = null;
  let blockScalarStyle: 'literal' | 'folded' | null = null;
  let blockScalarLines: string[] = [];
  let blockScalarIndent: number | null = null;

  const flushArray = () => {
    if (currentArrayKey) {
      result[currentArrayKey] = currentArray;
      currentArrayKey = null;
      currentArray = [];
    }
  };

  const flushBlockScalar = () => {
    if (!blockScalarKey) return;
    let value: string;
    if (blockScalarStyle === 'literal') {
      value = blockScalarLines.join('\n');
    } else {
      value = blockScalarLines.join('\n').replace(/(?<!\n)\n(?!\n)/g, ' ').trim();
    }
    result[blockScalarKey] = value;
    blockScalarKey = null;
    blockScalarStyle = null;
    blockScalarLines = [];
    blockScalarIndent = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle block scalar content
    if (blockScalarKey) {
      if (trimmed === '') {
        blockScalarLines.push('');
        continue;
      }
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (blockScalarIndent === null) {
        if (leadingSpaces === 0) {
          flushBlockScalar();
          // fall through to process this line
        } else {
          blockScalarIndent = leadingSpaces;
          blockScalarLines.push(line.slice(blockScalarIndent));
          continue;
        }
      } else if (leadingSpaces >= blockScalarIndent) {
        blockScalarLines.push(line.slice(blockScalarIndent));
        continue;
      } else {
        flushBlockScalar();
        // fall through
      }
    }

    // Handle YAML list items (- value)
    if (currentArrayKey && trimmed.startsWith('- ')) {
      currentArray.push(unquoteYaml(trimmed.slice(2).trim()));
      continue;
    }

    // Not a list item — flush any pending array
    if (currentArrayKey && trimmed !== '') {
      flushArray();
    }

    if (!trimmed) continue;

    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1].trim();
    const rawValue = match[2].trim();
    if (!key) continue;

    // Check for block scalar indicator (| or >) with optional chomping
    const blockMatch = rawValue.match(/^([|>])([+-])?$/);
    if (blockMatch) {
      blockScalarKey = key;
      blockScalarStyle = blockMatch[1] === '|' ? 'literal' : 'folded';
      blockScalarLines = [];
      blockScalarIndent = null;
      continue;
    }

    if (!rawValue) {
      // Could be start of a YAML list or a null value — peek ahead
      currentArrayKey = key;
      currentArray = [];
      continue;
    }

    result[key] = parseYamlValue(rawValue);
  }

  if (blockScalarKey) flushBlockScalar();
  flushArray();

  return result;
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
