import { ComposerEditor } from '@/features/chat/composer/ComposerEditor';
import { createWelcomeElement } from '@/features/chat/rendering/WelcomeRenderer';
import { SessionAlreadyAttached } from '@/features/chat/sessions/SessionRuntimePool';
import type { TabRuntimeConstructionContext, TabRuntimeCore } from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import { createTabIdentity, generateTabId, type TabIdentity } from '@/features/chat/tabs/TabIdentity';
import { TabSession } from '@/features/chat/tabs/TabSession';
import type { TabDOMElements } from '@/features/chat/tabs/types';

export function buildTabRuntimeCore(options: TabRuntimeConstructionContext): TabRuntimeCore {
  const { plugin, conversation } = options;
  const id = options.tabId ?? generateTabId();
  const contentEl = options.containerEl.createDiv({ cls: 'claudian-tab-content claudian-hidden' });
  options.registerCleanup('tab DOM root', () => contentEl.remove());
  const dom = buildTabDOM(contentEl, options);
  const identity = options.initialState ? { ...options.initialState }
    : createTabIdentity(plugin.settings, conversation, { ...options, tabId: id });
  const sessionIdentity = options.draftSessionKey ? { ...identity, draftSessionKey: options.draftSessionKey } : identity;
  const acquisition = plugin.sessionRuntimes.acquire(sessionIdentity, { reveal: options.revealSession ?? (() => dom.inputEl.focus()) });
  if (!acquisition.acquired) throw new SessionAlreadyAttached(acquisition.attachment);
  const { runtime } = acquisition.attachment;
  options.registerCleanup('session attachment', () => plugin.sessionRuntimes.release(acquisition.attachment));
  const model = runtime.model;
  // The tab keeps only presentation identity; the session owns conversation, provider, and draft.
  const session = new TabSession({
    id: identity.id, lifecycleState: identity.lifecycleState, ...(identity.label ? { label: identity.label } : {}),
  }, runtime);
  const catalogContext: Readonly<TabIdentity> = {
    get id() { return session.id; },
    get lifecycleState() { return session.lifecycleState; },
    get conversationId() { return session.conversationId; },
    get providerId() { return session.providerId; },
    get draftModel() { return session.draftModel; },
  };
  return {
    session,
    get id() { return session.id; },
    get lifecycleState() { return session.lifecycleState; },
    get conversationId() { return session.conversationId; },
    get providerId() { return session.providerId; },
    get draftModel() { return session.draftModel; },
    get hydrationState() { return model.hydrationState; },
    set hydrationState(value) { model.hydrationState = value; },
    executionCoordinator: runtime.executionCoordinator,
    providerCatalogResolver: () => options.getProviderCatalogConfig(catalogContext),
    captureReviewableSettlement: outcome => model.captureReview(outcome),
    state: model.state,
    dom,
    services: model,
  };
}

function buildTabDOM(contentEl: HTMLElement, options: TabRuntimeConstructionContext): TabDOMElements {
  const messagesWrapperEl = contentEl.createDiv({ cls: 'claudian-messages-wrapper' });
  const messagesEl = messagesWrapperEl.createDiv({ cls: 'claudian-messages' });
  const welcomeEl = createWelcomeElement(messagesEl);
  const inputComposerEl = contentEl.createDiv({ cls: 'claudian-input-composer' });
  const inputContainerEl = inputComposerEl.createDiv({ cls: 'claudian-input-container' });
  const navRowEl = inputContainerEl.createDiv({ cls: 'claudian-input-nav-row' });
  const inputWrapper = inputContainerEl.createDiv({ cls: 'claudian-input-wrapper' });
  // A queued follow-up is attached to the top of the box it will be sent from.
  const queueIndicatorEl = inputWrapper.createDiv({ cls: 'claudian-input-queue-strip claudian-hidden' });
  const contextRowEl = inputWrapper.createDiv({ cls: 'claudian-context-row' });
  const composerEditor = new ComposerEditor(inputWrapper, options.plugin.app, options.component);
  const infoRowEl = inputContainerEl.createDiv({ cls: 'claudian-input-info-row' });
  options.registerCleanup('tab composer editor', () => composerEditor.destroy());
  const vault = options.plugin.app.vault;
  const refresh = () => composerEditor.refreshLinks();
  for (const subscribe of [
    () => vault.on('create', refresh),
    () => vault.on('delete', refresh),
    () => vault.on('rename', refresh),
  ]) {
    const ref = subscribe();
    options.registerCleanup('composer vault listener', () => vault.offref(ref));
  }
  const inputEl = composerEditor.element;

  return {
    contentEl,
    messagesWrapperEl,
    messagesEl,
    welcomeEl,
    inputComposerEl,
    inputContainerEl,
    queueIndicatorEl,
    inputWrapper,
    inputEl,
    navRowEl,
    contextRowEl,
    infoRowEl,
  };
}
