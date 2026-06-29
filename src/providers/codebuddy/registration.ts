import type { ProviderRegistration } from '../../core/providers/types';
import { CodeBuddyTaskResultInterpreter } from './auxiliary/CodeBuddyTaskResultInterpreter';
import {
  CodeBuddyInlineEditService,
  CodeBuddyInstructionRefineService,
  CodeBuddyTitleGenerationService,
} from './auxiliary/UnsupportedCodeBuddyServices';
import { CODEBUDDY_PROVIDER_CAPABILITIES } from './capabilities';
import { codeBuddySettingsReconciler } from './env/CodeBuddySettingsReconciler';
import { CodeBuddyConversationHistoryService } from './history/CodeBuddyConversationHistoryService';
import { CodeBuddyChatRuntime } from './runtime/CodeBuddyChatRuntime';
import { getCodeBuddyProviderSettings } from './settings';
import { codeBuddyChatUIConfig } from './ui/CodeBuddyChatUIConfig';

export const codeBuddyProviderRegistration: ProviderRegistration = {
  blankTabOrder: 12,
  capabilities: CODEBUDDY_PROVIDER_CAPABILITIES,
  chatUIConfig: codeBuddyChatUIConfig,
  createInlineEditService: () => new CodeBuddyInlineEditService(),
  createInstructionRefineService: () => new CodeBuddyInstructionRefineService(),
  createRuntime: ({ plugin }) => new CodeBuddyChatRuntime(plugin),
  createTitleGenerationService: () => new CodeBuddyTitleGenerationService(),
  displayName: 'CodeBuddy',
  environmentKeyPatterns: [/^CODEBUDDY_/i],
  historyService: new CodeBuddyConversationHistoryService(),
  isEnabled: (settings) => getCodeBuddyProviderSettings(settings).enabled,
  settingsReconciler: codeBuddySettingsReconciler,
  taskResultInterpreter: new CodeBuddyTaskResultInterpreter(),
};
