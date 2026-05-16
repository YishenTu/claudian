import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type ClaudianPlugin from '../../../main';
import { CursorAuxQueryRunner } from '../runtime/CursorAuxQueryRunner';

export class CursorInstructionRefineService extends QueryBackedInstructionRefineService {
  constructor(plugin: ClaudianPlugin) {
    super(new CursorAuxQueryRunner(plugin));
  }
}
