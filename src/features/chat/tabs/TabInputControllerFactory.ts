import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { FeatureHost } from '../../FeatureHost';
import { InputController } from '../controllers/InputController';
import { autoResizeTextarea } from '../ui/textareaResize';
import { getTabProviderId } from './providerResolution';
import type { TabData } from './types';

export interface TabInputControllerOptions {
  ensureExecutionInitialized: () => Promise<boolean>;
  generateId: () => string;
  getAuxiliaryModel: () => string | null;
  openConversation?: (conversationId: string) => Promise<void>;
  handleNewConversationCommand?: () => Promise<boolean>;
  handleNewSessionPlan?: (planContent: string) => Promise<boolean>;
  onForkAll?: () => Promise<void>;
  toggleFastMode: () => Promise<boolean>;
  restorePrePlanPermissionModeIfNeeded: () => void | Promise<void>;
  onDiagnosticError: (error: unknown) => void;
}

/**
 * Assembles InputController from the tab runtime and a small set of layout
 * and provider-transition hooks. Input behavior itself remains owned by the
 * controller; this module only owns dependency wiring and preflight policy.
 */
export function createTabInputController(
  tab: TabData,
  plugin: FeatureHost,
  options: TabInputControllerOptions,
): InputController {
  const { dom, state, services, ui, controllers } = tab;
  return new InputController({
    plugin,
    state,
    renderer: tab.renderer!,
    streamController: controllers.streamController!,
    selectionController: controllers.selectionController!,
    browserSelectionController: controllers.browserSelectionController ?? undefined,
    canvasSelectionController: controllers.canvasSelectionController!,
    conversationController: controllers.conversationController!,
    getInputEl: () => dom.inputEl,
    getInputContainerEl: () => dom.inputContainerEl,
    getWelcomeEl: () => dom.welcomeEl,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    getImageContextManager: () => ui.imageContextManager,
    getMcpServerSelector: () => ui.mcpServerSelector,
    getExternalContextSelector: () => ui.externalContextSelector,
    getInstructionModeManager: () => ui.instructionModeManager,
    getInstructionRefineService: () => services.instructionRefineService,
    getTitleGenerationService: () => services.titleGenerationService,
    getStatusPanel: () => ui.statusPanel,
    generateId: options.generateId,
    resetInputHeight: () => autoResizeTextarea(dom.inputEl),
    getAuxiliaryModel: options.getAuxiliaryModel,
    getExecutionCoordinator: () => tab.executionCoordinator,
    getSubagentManager: () => services.subagentManager,
    getTabProviderId: () => getTabProviderId(tab, plugin),
    turnOwner: tab.session,
    ensureExecutionInitialized: options.ensureExecutionInitialized,
    openConversation: options.openConversation,
    handleNewConversationCommand: options.handleNewConversationCommand,
    handleNewSessionPlan: options.handleNewSessionPlan,
    onForkAll: options.onForkAll,
    toggleFastMode: options.toggleFastMode,
    restorePrePlanPermissionModeIfNeeded: options.restorePrePlanPermissionModeIfNeeded,
    captureReviewableSettlement: tab.captureReviewableSettlement ?? undefined,
    onDiagnosticError: options.onDiagnosticError,
    preflightExecution: async () => {
      let diagnostics;
      try {
        diagnostics = await ProviderRegistry.collectDiagnostics(tab.providerId, {
          settings: plugin.settings,
          resolveCliPath: () => plugin.providerHost.getResolvedProviderCliPath(tab.providerId),
        });
      } catch {
        return new Error('Provider CLI not found.');
      }
      if (diagnostics?.readiness?.status === 'disabled') {
        return new Error('Provider is not enabled.');
      }
      const blockedCheck = diagnostics?.readiness?.checks.find(check => check.status === 'blocked');
      if (!blockedCheck) return null;
      if (blockedCheck.id === 'cli') return new Error('Provider CLI not found.');
      if (blockedCheck.id === 'selection') return new Error('No chat model is selected.');
      if (blockedCheck.id === 'enabled') return new Error('Provider is not enabled.');
      return new Error('Provider model catalog is unavailable.');
    },
  });
}
