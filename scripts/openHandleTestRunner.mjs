import { setTimeout } from 'node:timers/promises';
import { TestRunner } from 'vitest';

export default class OpenHandleTestRunner extends TestRunner {
  async onAfterRunFiles(files) {
    await super.onAfterRunFiles(files);
    // Vitest snapshots async resources before environment teardown. Close the
    // environment-owned DOM timers first, as jsdom's normal teardown does.
    globalThis.jsdom?.window.close();
    // Allow short-lived I/O and focus timers to finish before the leak snapshot.
    await setTimeout(100);
  }
}
