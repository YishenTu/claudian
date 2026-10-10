import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';

export class CodexMetadataTransitionGate extends ProviderTransitionFence {
  constructor() {
    super({ abortMessage: 'Codex metadata transition wait aborted' });
  }
}
