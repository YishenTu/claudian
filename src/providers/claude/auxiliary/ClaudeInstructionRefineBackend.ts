import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ClaudeAuxQueryRunner } from '../runtime/ClaudeAuxQueryRunner';

export class ClaudeInstructionRefineBackend extends ClaudeAuxQueryRunner {
  constructor(plugin: ProviderHost) {
    super(plugin, { tools: [] });
  }
}
