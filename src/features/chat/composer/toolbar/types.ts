import type { ChatSettings } from '@/features/chat/ChatSettings';
import type { ModelPickerCallbacks } from '@/shared/toolbar/types';

export type ToolbarSettings = ChatSettings & Record<string, unknown>;

export interface ToolbarCallbacks extends ModelPickerCallbacks {
  onModeChange: (mode: string) => Promise<void>;
  onServiceTierChange: (serviceTier: string) => Promise<void>;
  onPermissionModeChange: (mode: string) => Promise<void>;
  getSettings: () => ToolbarSettings;
}
