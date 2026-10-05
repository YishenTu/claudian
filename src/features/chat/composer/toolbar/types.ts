import type { ProviderCapabilities, ProviderChatUIConfig } from '@/core/providers/types';
import type { ChatSettings } from '@/features/chat/ChatSettings';

export type ToolbarSettings = ChatSettings & Record<string, unknown>;

export interface ToolbarCallbacks {
  onModelChange: (model: string) => Promise<void>;
  onModeChange: (mode: string) => Promise<void>;
  onEffortLevelChange: (effort: string) => Promise<void>;
  onServiceTierChange: (serviceTier: string) => Promise<void>;
  onPermissionModeChange: (mode: string) => Promise<void>;
  getSettings: () => ToolbarSettings;
  getEnvironmentVariables?: () => string;
  getUIConfig: () => ProviderChatUIConfig;
  getCapabilities: () => ProviderCapabilities;
}
