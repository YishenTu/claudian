import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { PiAuxQueryRunner } from '../runtime/PiAuxQueryRunner';

export class PiInstructionRefineService extends QueryBackedInstructionRefineService {
  constructor(plugin: ProviderHost) {
    super(new PiAuxQueryRunner(plugin, { profile: 'passive' }));
  }
}
