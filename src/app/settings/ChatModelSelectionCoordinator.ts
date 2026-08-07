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
    isStillValid: () => boolean,
  ): Promise<boolean> {
    const commit = this.commitTail.then(async () => {
      if (intent <= this.committedIntent || !isStillValid()) {
        return false;
      }

      let didCommit = false;
      await this.settingsCoordinator.mutateConditionally((settings) => {
        if (!isStillValid()) return false;
        settings.lastSelectedChatModel = { ...selection };
        didCommit = true;
        return true;
      });
      if (!didCommit) return false;

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
