import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type ClaudianPlugin from '../../../main';
import { HermesAuxQueryRunner } from '../runtime/HermesAuxQueryRunner';

export class HermesInstructionRefineService extends QueryBackedInstructionRefineService {
  constructor(plugin: ClaudianPlugin) {
    super(new HermesAuxQueryRunner(plugin));
  }
}
