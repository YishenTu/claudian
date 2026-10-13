import type { ClaudianSettings, StoredChatModelSelection } from '../../core/types';
import type { SettingsCoordinator } from './SettingsCoordinator';

export class ChatModelSelectionCoordinator {
  private nextIntent = 0;
  private committedIntent = 0;

  constructor(
    private readonly settingsCoordinator: SettingsCoordinator<ClaudianSettings>,
  ) {}

  beginIntent(): number {
    this.nextIntent += 1;
    return this.nextIntent;
  }

  async commitIntent(
    intent: number,
    selection: StoredChatModelSelection,
    isStillValid: () => boolean,
  ): Promise<boolean> {
    let didCommit = false;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      if (intent <= this.committedIntent || !isStillValid()) return false;
      settings.lastSelectedChatModel = { ...selection };
      didCommit = true;
      return true;
    }, () => {
      if (didCommit) this.committedIntent = intent;
    });
    return didCommit;
  }
}
