import type { ProviderRegistration } from '../../core/providers/types';
import { AcpChatRuntime } from './runtime/AcpChatRuntime';
import { AcpTitleGenerationService } from './auxiliary/AcpTitleGenerationService';
import { AcpInstructionRefineService } from './auxiliary/AcpInstructionRefineService';
import { AcpInlineEditService } from './auxiliary/AcpInlineEditService';
import { AcpConversationHistoryService } from './history/AcpConversationHistoryService';
import { AcpTaskResultInterpreter } from './auxiliary/AcpTaskResultInterpreter';
import { ACP_PROVIDER_CAPABILITIES } from './capabilities';
import { acpSettingsReconciler } from './env/AcpSettingsReconciler';
import { acpChatUIConfig } from './ui/AcpChatUIConfig';
import { getAcpProviderSettings } from './settings';

export const acpProviderRegistration: ProviderRegistration = {
  displayName: 'ACP',
  blankTabOrder: 30,
  isEnabled: (settings) => getAcpProviderSettings(settings).enabled,
  capabilities: ACP_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^ACP_/i],
  chatUIConfig: acpChatUIConfig,
  settingsReconciler: acpSettingsReconciler,
  createRuntime: ({ plugin }) => new AcpChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new AcpTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new AcpInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new AcpInlineEditService(plugin),
  historyService: new AcpConversationHistoryService(),
  taskResultInterpreter: new AcpTaskResultInterpreter(),
};
