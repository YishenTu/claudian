import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { App, Scope } from 'obsidian';

import type { ChatFeatureHost, ChatViewHost } from '@/features/chat/ChatFeatureHost';
import { ClaudianView } from '@/features/chat/ClaudianView';

export interface ClaudianViewHarnessOptions {
  /** Merged over a minimal feature host; read by every view collaborator at construction. */
  plugin?: Parameters<typeof createChatFeatureHost>[0];
  /** A complete feature host used as is, for integration tests that share it with other owners. */
  host?: ChatFeatureHost;
  /** Merged over a minimal Obsidian app with a parent keymap scope. */
  app?: object;
  /** Defaults to a real element in the current document. */
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
export async function createClaudianView(options: ClaudianViewHarnessOptions = {}): Promise<Record<string, any> & ChatViewHost & Pick<ClaudianView, 'containerEl' | 'contentEl'>> {
  const app = new App();
  Object.assign(app.workspace, {
    layoutReady: true,
    onLayoutReady: vi.fn((callback: () => void) => callback()),
    requestSaveLayout: Object.assign(vi.fn(), { run: vi.fn() }),
  });
  vi.spyOn(app.vault, 'on');
  vi.spyOn(app.vault, 'offref');
  vi.spyOn(app.metadataCache, 'on');
  vi.spyOn(app.metadataCache, 'offref');
  const overrides = options.plugin ?? {};
  const ports = { projects: createProjectsFake(), registerZenModeSource: vi.fn(() => vi.fn()) };
  const plugin = options.host ?? await createChatFeatureHost(overrides.fixture
    ? { ...ports, ...overrides }
    : { app, ...ports, ...overrides });
  const view = new ClaudianView(
    (options.leaf ?? {}) as never,
    plugin,
  ) as any;
  Object.assign(view, {
    app: Object.assign(plugin.app, { scope: new Scope() }, options.app),
    containerEl: options.containerEl ?? document.createElement('div'),
    contentEl: options.contentEl ?? document.createElement('div'),
    ...(options.tabManager ? { tabManager: options.tabManager } : {}),
  });
  vi.spyOn(view, 'registerDomEvent');
  vi.spyOn(view, 'registerEvent');
  return view;
}
