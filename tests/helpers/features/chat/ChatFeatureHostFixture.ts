import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';

import type { ClaudianSettings } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';

function unconfiguredCapability(): never {
  throw new Error('Supply the ChatFeatureHost capability exercised by this test.');
}

type FeatureFixture = Awaited<ReturnType<typeof createFeatureHostFixture>>;
export type ChatFeatureHostOverrides = Partial<Omit<ChatFeatureHost, 'settings' | 'app'>>;
export type ChatFeatureHostOptions = ChatFeatureHostOverrides & (
  | { fixture: FeatureFixture; settings?: never; app?: never }
  | { fixture?: never; settings?: Partial<ClaudianSettings>; app?: ChatFeatureHost['app'] }
);

/** A typed chat host; tests supply the app capabilities their behavior actually exercises. */
// Do not spread returned hosts: use factory overrides to preserve unconfigured-capability access guards.
export async function createChatFeatureHost({ fixture: existingFixture, settings, app, ...overrides }: ChatFeatureHostOptions = {}):
Promise<ChatFeatureHost & { settings: ClaudianSettings }> {
  const fixture = existingFixture ?? await createFeatureHostFixture({ settings, app });
  const host: ChatFeatureHost & { settings: ClaudianSettings } = {
    ...fixture.host,
    settings: fixture.settings,
    get sessionRuntimes() { return unconfiguredCapability(); },
    get chatModelSelection() { return unconfiguredCapability(); },
    get conversationLifecycle() { return unconfiguredCapability(); },
    get executionPersistence() { return unconfiguredCapability(); },
    get projects() { return unconfiguredCapability(); },
    bindSessionTools: unconfiguredCapability,
    createConversation: unconfiguredCapability,
    switchConversation: unconfiguredCapability,
    assignConversationToCurrentDevice: unconfiguredCapability,
    deleteConversation: unconfiguredCapability,
    handleMissingProviderSession: unconfiguredCapability,
    renameConversation: unconfiguredCapability,
    completeConversationTitleGeneration: unconfiguredCapability,
    setLinkedContentPinned: unconfiguredCapability,
    getWorkspaceConversationIds: () => new Set(),
    updateConversation: unconfiguredCapability,
    getConversationById: async () => null,
    getCachedConversation: () => null,
    getConversationSummary: () => null,
    getConversationSync: () => null,
    getConversationList: () => [],
    ensureConversationMetadataLoaded: unconfiguredCapability,
    registerZenModeSource: unconfiguredCapability,
    getView: () => null,
    getAllViews: () => [],
    findConversationAcrossViews: () => null,
  };
  // Chai inspects even non-enumerable own properties; inherited defaults preserve access guards without masking diffs.
  const defaults = Object.create(Object.getPrototypeOf(host));
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(host))) {
    if (!descriptor.get) continue;
    Object.defineProperty(defaults, key, { ...descriptor, enumerable: false });
    Reflect.deleteProperty(host, key);
  }
  Object.setPrototypeOf(host, defaults);
  // Preserve throwing defaults until a test explicitly supplies a capability.
  Object.defineProperties(host, Object.getOwnPropertyDescriptors(overrides));
  return host;
}
