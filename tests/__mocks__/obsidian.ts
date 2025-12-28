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

export class Notice {
  constructor(_message: string) {}
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
