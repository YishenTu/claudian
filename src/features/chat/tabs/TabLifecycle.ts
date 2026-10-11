import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

export interface TabRuntimeCleanupFailure {
  readonly resource: string;
  readonly error: unknown;
}

export interface TabRuntimeResourceOwner {
  dispose(): Promise<readonly TabRuntimeCleanupFailure[]>;
}

const tabDestructionPromises = new WeakMap<AssembledTabRuntime, Promise<void>>();
const tabShutdownDrainPromises = new WeakMap<
  AssembledTabRuntime,
  Promise<TabShutdownDrainResult>
>();
const tabRuntimeResourceOwners = new WeakMap<
  AssembledTabRuntime,
  TabRuntimeResourceOwner
>();

export function registerTabRuntimeResourceOwner(
  tab: AssembledTabRuntime,
  resourceOwner: TabRuntimeResourceOwner,
): void {
  if (tabRuntimeResourceOwners.has(tab)) {
    throw new Error('Tab runtime already has a registered resource owner');
  }
  tabRuntimeResourceOwners.set(tab, resourceOwner);
}

export function commitProvisionalTab(tab: AssembledTabRuntime): void {
  tab.session.claimUserOwnership();
  if (tab.lifecycleState === 'provisional') {
    tab.session.commitAdmission();
  }
}

export function activateTab(tab: AssembledTabRuntime): void {
  tab.dom.contentEl.removeClass('claudian-hidden');
  tab.controllers.streamController.setTabActive(true);
  tab.controllers.sideChatController.setTabActive(true);
  tab.controllers.composerSelections.start();
  tab.ui.navigationSidebar.updateVisibility();
}

export function deactivateTab(tab: AssembledTabRuntime): void {
  tab.ui.promptSuggestion.discard();
  tab.controllers.streamController.setTabActive(false);
  tab.controllers.sideChatController.setTabActive(false);
  tab.dom.contentEl.addClass('claudian-hidden');
  tab.controllers.composerSelections.stop();
}

export class TabRuntimeTeardownError extends Error {
  readonly cleanupFailures: readonly TabRuntimeCleanupFailure[];

  constructor(cleanupFailures: readonly TabRuntimeCleanupFailure[]) {
    const resources = cleanupFailures.map(failure => failure.resource).join(', ');
    super(`Tab runtime teardown failed for: ${resources}`, {
      cause: cleanupFailures[0]?.error,
    });
    this.name = 'TabRuntimeTeardownError';
    this.cleanupFailures = cleanupFailures;
  }
}

export interface TabShutdownDrainResult {
  readonly cleanupFailures: readonly TabRuntimeCleanupFailure[];
}

async function captureTeardownFailure(
  failures: TabRuntimeCleanupFailure[],
  resource: string,
  cleanup: () => void | Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    failures.push({ error, resource });
  }
}

export async function drainTabForShutdownSnapshot(
  tab: AssembledTabRuntime,
): Promise<TabShutdownDrainResult> {
  const existingDrain = tabShutdownDrainPromises.get(tab);
  if (existingDrain) return existingDrain;

  const drain = drainTabForShutdownSnapshotOnce(tab);
  tabShutdownDrainPromises.set(tab, drain);
  return drain;
}

async function drainTabForShutdownSnapshotOnce(
  tab: AssembledTabRuntime,
): Promise<TabShutdownDrainResult> {
  const cleanupFailures: TabRuntimeCleanupFailure[] = [];
  await captureTeardownFailure(cleanupFailures, 'conversation shell creation',
    () => tab.session.runtime.awaitIdentitySettlement());

  return { cleanupFailures };
}

export async function destroyTab(tab: AssembledTabRuntime): Promise<void> {
  const existingDestruction = tabDestructionPromises.get(tab);
  if (existingDestruction) {
    await existingDestruction;
    return;
  }

  const destruction = destroyTabOnce(tab);
  tabDestructionPromises.set(tab, destruction);
  await destruction;
}

async function destroyTabOnce(tab: AssembledTabRuntime): Promise<void> {
  tab.session.beginClose();
  const cleanupFailures: TabRuntimeCleanupFailure[] = [];
  await captureTeardownFailure(
    cleanupFailures,
    'tab resume dropdown',
    () => tab.controllers.builtInCommandController.destroyResumeDropdown(),
  );
  const resourceOwner = tabRuntimeResourceOwners.get(tab);
  if (resourceOwner) {
    cleanupFailures.push(...await resourceOwner.dispose());
  } else {
    cleanupFailures.push({
      error: new Error('Assembled tab runtime has no registered resource owner'),
      resource: 'tab runtime resource owner',
    });
  }

  if (cleanupFailures.length > 0) {
    throw new TabRuntimeTeardownError(cleanupFailures);
  }
}

export function getTabTitle(tab: Pick<AssembledTabRuntime, 'conversationId'>, plugin: ChatFeatureHost): string {
  if (tab.conversationId) {
    const conversation = plugin.getConversationSummary(tab.conversationId);
    if (conversation?.title) {
      return conversation.title;
    }
  }
  return 'New Chat';
}
