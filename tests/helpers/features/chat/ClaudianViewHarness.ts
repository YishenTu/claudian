import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { App, Scope } from 'obsidian';

import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ClaudianView } from '@/features/chat/ClaudianView';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

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
  tabManager?: Partial<TabManager>;
  leaf?: unknown;
}

/**
 * Constructs a real `ClaudianView` with its real collaborators and public lifecycle.
 */
export async function createClaudianView(options: ClaudianViewHarnessOptions = {}): Promise<ClaudianView> {
  const app = options.host?.app ?? options.plugin?.fixture?.host.app ?? options.plugin?.app ?? new App();
  vi.spyOn(app.workspace, 'onLayoutReady');
  vi.spyOn(app.workspace, 'requestSaveLayout');
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
  );
  Object.assign(view, {
    app: Object.assign(plugin.app, { scope: new Scope() }, options.app),
    containerEl: options.containerEl ?? document.createElement('div'),
    contentEl: options.contentEl ?? document.createElement('div'),
  });
  if (options.tabManager) {
    view['tabManager'] = options.tabManager instanceof TabManager ? options.tabManager
      : Object.assign(new TabManager(plugin, view.contentEl, view, {},
        new VaultMentionDataProvider(plugin.app)), options.tabManager);
  }
  vi.spyOn(view, 'registerDomEvent');
  vi.spyOn(view, 'registerEvent');
  return view;
}
