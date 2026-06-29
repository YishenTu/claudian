import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type ClaudianPlugin from '../../../main';
import { HermesAuxQueryRunner } from '../runtime/HermesAuxQueryRunner';

export class HermesInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ClaudianPlugin) {
    super(new HermesAuxQueryRunner(plugin));
  }
}
