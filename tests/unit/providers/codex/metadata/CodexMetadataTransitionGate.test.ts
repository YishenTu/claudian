import { CodexMetadataTransitionGate } from '@/providers/codex/metadata/CodexMetadataTransitionGate';

describe('CodexMetadataTransitionGate', () => {
  it('normalizes a non-Error abort reason while waiting for a transition', async () => {
    const gate = new CodexMetadataTransitionGate();
    const controller = new AbortController();
    gate.beginTransition();

    const availability = gate.waitUntilAvailable(controller.signal);
    controller.abort('caller cancelled');

    await expect(availability).rejects.toMatchObject({
      cause: 'caller cancelled',
      message: 'Codex metadata transition wait aborted',
    });
    gate.dispose();
  });
});
