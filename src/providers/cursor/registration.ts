import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import { cursorWorkspaceRegistration } from './app/CursorWorkspaceServices';
import { CURSOR_PROVIDER_CAPABILITIES } from './capabilities';
import { cursorSettingsReconciler } from './env/CursorSettingsReconciler';
import { CursorExecutionBackend } from './execution/CursorExecutionBackend';
import { CursorConversationHistoryService } from './history/CursorConversationHistoryService';
import { getCursorProviderSettings, updateCursorProviderSettings } from './settings';
import { cursorChatUIConfig } from './ui/CursorChatUIConfig';

export const cursorProviderRegistration: ProviderModule = {
  id: 'cursor',
  blankTabOrder: 12,
  capabilities: CURSOR_PROVIDER_CAPABILITIES,
  chatUIConfig: cursorChatUIConfig,
  createExecutionBackend: plugin => new CursorExecutionBackend(plugin),
  displayName: 'Cursor',
  environmentKeyPatterns: [/^CURSOR_/i],
  historyService: new CursorConversationHistoryService(),
  isEnabled: settings => getCursorProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateCursorProviderSettings(settings, { enabled }),
  settingsReconciler: cursorSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'cursor');
      updateCursorProviderSettings(target, getCursorProviderSettings(stored));
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'cursor'),
      );
    },
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: cursorWorkspaceRegistration,
};
