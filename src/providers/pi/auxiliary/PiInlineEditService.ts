import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { PiAuxQueryRunner } from '../runtime/PiAuxQueryRunner';

export class PiInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ProviderHost) {
    super(new PiAuxQueryRunner(plugin, { profile: 'readonly' }));
  }
}
