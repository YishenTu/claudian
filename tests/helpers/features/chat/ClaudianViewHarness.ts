import { createMockEl } from '@test/helpers/MockElement';
import { ItemView, Scope } from 'obsidian';

import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ClaudianView } from '@/features/chat/ClaudianView';

// The Obsidian mock's ItemView omits Component's `load`, which the view's Hover Editor guard binds.
const itemViewPrototype = ItemView.prototype as unknown as { load?: () => void };
itemViewPrototype.load ??= () => undefined;

export interface ClaudianViewHarnessOptions {
  /** Merged over a minimal feature host; read by every view collaborator at construction. */
  plugin?: Record<string, unknown>;
  /** A complete feature host used as is, for integration tests that share it with other owners. */
  host?: ChatFeatureHost;
  /** Merged over a minimal Obsidian app with a parent keymap scope. */
  app?: object;
  /** Defaults to a mock element; DOM tests pass real elements. */
  containerEl?: HTMLElement;
  contentEl?: HTMLElement;
  /** Installs a tab manager without running `onOpen`, for tests of a single view operation. */
  tabManager?: unknown;
  leaf?: unknown;
}

/**
 * Constructs a real `ClaudianView` with its real collaborators. Returned untyped so tests
 * can drive the lifecycle seams (`tabManager`, `tabWorkspace`, `scope`) that Obsidian owns.
 */
export function createClaudianView(options: ClaudianViewHarnessOptions = {}): any {
  const plugin = options.host ?? {
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        offref: jest.fn(),
        on: jest.fn((name: string) => ({ name })),
      },
      workspace: {
        on: jest.fn((name: string) => ({ name })),
        requestSaveLayout: Object.assign(jest.fn(), { run: jest.fn() }),
      },
      metadataCache: { on: jest.fn((name: string) => ({ name })) },
    },
    getAllViews: () => [],
    getConversationList: () => [],
    getConversationSummary: () => null,
    findConversationAcrossViews: () => null,
    registerZenModeSource: jest.fn(() => jest.fn()),
    settings: {},
    ...options.plugin,
  };
  const view = new ClaudianView(
    (options.leaf ?? {}) as never,
    plugin as unknown as ChatFeatureHost,
  ) as any;
  Object.assign(view, {
    app: { scope: new Scope(), workspace: { on: jest.fn(), offref: jest.fn() }, ...options.app },
    registerDomEvent: jest.fn(),
    registerEvent: jest.fn(),
    containerEl: options.containerEl ?? createMockEl(),
    contentEl: options.contentEl ?? createMockEl(),
    ...(options.tabManager ? { tabManager: options.tabManager } : {}),
  });
  return view;
}
