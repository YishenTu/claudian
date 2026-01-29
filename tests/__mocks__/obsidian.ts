// Mock for Obsidian API

export class Plugin {
  app: any;
  manifest: any;

  constructor(app?: any, manifest?: any) {
    this.app = app;
    this.manifest = manifest;
  }

  addRibbonIcon = jest.fn();
  addCommand = jest.fn();
  addSettingTab = jest.fn();
  registerView = jest.fn();
  loadData = jest.fn().mockResolvedValue({});
  saveData = jest.fn().mockResolvedValue(undefined);
}

export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: any = {
    empty: jest.fn(),
    createEl: jest.fn().mockReturnValue({ createEl: jest.fn(), createDiv: jest.fn() }),
    createDiv: jest.fn().mockReturnValue({ createEl: jest.fn(), createDiv: jest.fn() }),
  };

  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }

  display() {}
}

export class ItemView {
  app: any;
  leaf: any;
  containerEl: any = {
    children: [{}, { empty: jest.fn(), addClass: jest.fn(), createDiv: jest.fn().mockReturnValue({
      createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn(), setAttribute: jest.fn() }),
      createDiv: jest.fn().mockReturnValue({ createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }) }),
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

export class WorkspaceLeaf {}

export class App {
  vault: any = {
    adapter: {
      basePath: '/mock/vault/path',
    },
  };
  workspace: any = {
    getLeavesOfType: jest.fn().mockReturnValue([]),
    getRightLeaf: jest.fn().mockReturnValue({
      setViewState: jest.fn().mockResolvedValue(undefined),
    }),
    revealLeaf: jest.fn(),
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
  constructor(containerEl: any) {}
  setName = jest.fn().mockReturnThis();
  setDesc = jest.fn().mockReturnThis();
  addToggle = jest.fn().mockReturnThis();
  addTextArea = jest.fn().mockReturnThis();
}

export class TextAreaComponent {
  inputEl: any;
  private _value = '';

  constructor(_container?: any) {
    this.inputEl = {
      addClass: jest.fn(),
      rows: 0,
      placeholder: '',
      focus: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
  }

  setValue(value: string): this {
    this._value = value;
    return this;
  }

  getValue(): string {
    return this._value;
  }
}

export class Modal {
  app: any;
  containerEl: any = {
    createDiv: jest.fn().mockReturnValue({
      createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
      createDiv: jest.fn().mockReturnValue({
        createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
        createDiv: jest.fn().mockReturnValue({
          createEl: jest.fn(),
        }),
        setText: jest.fn(),
      }),
      addClass: jest.fn(),
      setText: jest.fn(),
    }),
    empty: jest.fn(),
    addClass: jest.fn(),
  };
  contentEl: any = {
    createDiv: jest.fn().mockReturnValue({
      createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
      createDiv: jest.fn().mockReturnValue({
        createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
        createDiv: jest.fn().mockReturnValue({
          createEl: jest.fn(),
        }),
        setText: jest.fn(),
      }),
      addClass: jest.fn(),
      setText: jest.fn(),
    }),
    empty: jest.fn(),
    addClass: jest.fn(),
  };

  constructor(app: any) {
    this.app = app;
  }

  open = jest.fn();
  close = jest.fn();
  onOpen = jest.fn();
  onClose = jest.fn();
}

export const MarkdownRenderer = {
  renderMarkdown: jest.fn().mockResolvedValue(undefined),
};

export const setIcon = jest.fn();

// Notice mock that tracks constructor calls
export const Notice = jest.fn().mockImplementation((_message: string, _timeout?: number) => {});

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
