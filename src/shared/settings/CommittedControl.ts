import { Notice } from 'obsidian';

/** A persisted settings write whose later publication failed. */
export function isCommittedSettingsError(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && 'committed' in error && error.committed === true;
}

export interface CommittedControlNotices {
  /** Shown when the write itself was rejected. */
  rejected: string;
  /** Shown when the write committed and only publication failed. */
  committed: string;
}

/**
 * Keep a native control aligned with the serialized settings owner's committed snapshot.
 * `save` returns false when the draft must stay visible, such as a validation failure.
 * With `notices`, commit failures are reported here. An uncommitted rejection also leaves the draft.
 */
export function bindCommittedControl<T>(
  control: { setValue(value: T): unknown; onChange(callback: (value: T) => Promise<void>): unknown },
  getValue: () => T,
  save: (value: T) => Promise<void | false>,
  onChanged?: () => void,
  notices?: CommittedControlNotices,
): void {
  let synchronizing = false;
  let generation = 0;
  let displayed = getValue();
  control.setValue(displayed);
  control.onChange(async value => {
    if (synchronizing) return;
    const savedGeneration = ++generation;
    const previous = displayed;
    let resync = true;
    try {
      if (await save(value) === false) resync = false;
    } catch (error) {
      if (!notices) throw error;
      const committed = isCommittedSettingsError(error);
      new Notice(committed ? notices.committed : notices.rejected);
      if (!committed) resync = false;
    } finally {
      // A newer edit owns the draft. An older save must not write the committed value over it.
      if (resync && savedGeneration === generation) {
        synchronizing = true;
        try {
          displayed = getValue();
          control.setValue(displayed);
        } finally {
          synchronizing = false;
        }
        if (displayed !== previous) onChanged?.();
      }
    }
  });
}
