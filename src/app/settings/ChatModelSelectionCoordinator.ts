import type { ClaudianSettings, StoredChatModelSelection } from '../../core/types';
import type { SettingsCoordinator } from './SettingsCoordinator';

export class ChatModelSelectionCoordinator {
  private nextIntent = 0;
  private committedIntent = 0;
  private commitTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly settingsCoordinator: SettingsCoordinator<ClaudianSettings>,
  ) {}

  beginIntent(): number {
    this.nextIntent += 1;
    return this.nextIntent;
  }

  commitIntent(
    intent: number,
    selection: StoredChatModelSelection,
  ): Promise<boolean> {
    const commit = this.commitTail.then(async () => {
      if (intent <= this.committedIntent) {
        return false;
      }

      await this.settingsCoordinator.mutate((settings) => {
        settings.lastSelectedChatModel = { ...selection };
      });
      this.committedIntent = intent;
      return true;
    });
    this.commitTail = commit.then(
      () => undefined,
      () => undefined,
    );
    return commit;
  }
}
