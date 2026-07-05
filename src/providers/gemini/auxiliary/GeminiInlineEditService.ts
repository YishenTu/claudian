import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type ClaudianPlugin from '../../../main';
import { GeminiAuxQueryRunner } from '../runtime/GeminiAuxQueryRunner';

export class GeminiInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ClaudianPlugin) {
    super(new GeminiAuxQueryRunner(plugin));
  }
}
