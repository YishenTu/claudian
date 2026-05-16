import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type ClaudianPlugin from '../../../main';
import { CursorAuxQueryRunner } from '../runtime/CursorAuxQueryRunner';

export class CursorInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ClaudianPlugin) {
    super(new CursorAuxQueryRunner(plugin));
  }
}
