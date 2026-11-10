import { Notice } from 'obsidian';

/** Runs a session or project action, reporting any failure once as a notice. */
export function runSessionAction(action: () => unknown, failureMessage: string): void {
  void (async () => {
    try {
      await action();
    } catch {
      new Notice(failureMessage);
    }
  })();
}
