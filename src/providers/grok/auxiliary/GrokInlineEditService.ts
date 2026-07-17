import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { GrokAuxQueryRunner } from '../runtime/GrokAuxQueryRunner';

export class GrokInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ProviderHost) {
    super(new GrokAuxQueryRunner(plugin));
  }
}
