import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { KimiAuxQueryRunner } from '../runtime/KimiAuxQueryRunner';

export class KimiInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ProviderHost) {
    super(new KimiAuxQueryRunner(plugin, { allowReadTextFile: true }));
  }
}
