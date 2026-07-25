import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { KimiAuxQueryRunner } from '../runtime/KimiAuxQueryRunner';

export class KimiInstructionRefineService extends QueryBackedInstructionRefineService {
  constructor(plugin: ProviderHost) {
    super(new KimiAuxQueryRunner(plugin));
  }
}
