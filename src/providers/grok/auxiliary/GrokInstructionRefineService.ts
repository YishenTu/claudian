import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { GrokAuxQueryRunner } from '../runtime/GrokAuxQueryRunner';

export class GrokInstructionRefineService extends QueryBackedInstructionRefineService {
  constructor(plugin: ProviderHost) {
    super(new GrokAuxQueryRunner(plugin));
  }
}
