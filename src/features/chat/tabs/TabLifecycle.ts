import { Notice } from 'obsidian';

import type { FeatureHost } from '../../FeatureHost';
import type {
  AssembledTabRuntime,
  TabRuntimeCleanupFailure,
  TabRuntimeResourceOwner,
} from './types';

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

export function isClosingLifecycleState(
  state: AssembledTabRuntime['lifecycleState'],
): boolean {
  return state === 'closing';
}

export function commitProvisionalTab(tab: AssembledTabRuntime): void {
  tab.session.claimUserOwnership();
  if (tab.lifecycleState === 'provisional') {
    tab.lifecycleState = 'cold';
  }
}

export function activateTab(tab: AssembledTabRuntime): void {
  tab.dom.contentEl.removeClass('claudian-hidden');
  tab.controllers.streamController.setTabActive(true);
  tab.controllers.selectionController.start();
  tab.controllers.browserSelectionController.start();
  tab.controllers.canvasSelectionController.start();
  tab.ui.navigationSidebar.updateVisibility();
}

export function deactivateTab(tab: AssembledTabRuntime): void {
  tab.controllers.streamController.setTabActive(false);
  tab.dom.contentEl.addClass('claudian-hidden');
  tab.controllers.selectionController.stop();
  tab.controllers.browserSelectionController.stop();
  tab.controllers.canvasSelectionController.stop();
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
  readonly cancelledActiveTurn: boolean;
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
  tab.session.pauseIntentAdmission();
  tab.session.pauseBackgroundWork();
  const cleanupFailures: TabRuntimeCleanupFailure[] = [];

  await captureTeardownFailure(
    cleanupFailures,
    'tab pending provider interaction',
    () => tab.controllers.inputController.dismissPendingApproval(),
  );
  const activeTurn = tab.session.activeTurn;
  const cancelledActiveTurn = activeTurn !== null;
  if (activeTurn) {
    tab.state.cancelRequested = true;
    tab.state.bumpStreamGeneration();
    await captureTeardownFailure(
      cleanupFailures,
      'tab active execution cancellation',
      () => tab.executionCoordinator.cancel(),
    );
    await activeTurn.catch(() => undefined);
  }
  await captureTeardownFailure(
    cleanupFailures,
    'tab background work',
    () => tab.session.awaitBackgroundWork(),
  );

  return { cancelledActiveTurn, cleanupFailures };
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
  tab.lifecycleState = 'closing';
  const drainResult = await drainTabForShutdownSnapshot(tab);
  const cleanupFailures = [...drainResult.cleanupFailures];
  const { cancelledActiveTurn } = drainResult;

  await captureTeardownFailure(cleanupFailures, 'tab subagent activity', () => {
    tab.services.subagentManager.orphanAllActive();
  });
  if (tab.state.currentConversationId) {
    try {
      await tab.controllers.conversationController.save(cancelledActiveTurn);
    } catch {
      new Notice('Background task state could not be saved before closing the tab.');
    }
  }
  await captureTeardownFailure(
    cleanupFailures,
    'tab resume dropdown',
    () => tab.controllers.inputController.destroyResumeDropdown(),
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

export function getTabTitle(tab: AssembledTabRuntime, plugin: FeatureHost): string {
  if (tab.conversationId) {
    const conversation = plugin.getConversationSync(tab.conversationId);
    if (conversation?.title) {
      return conversation.title;
    }
  }
  return 'New Chat';
}
