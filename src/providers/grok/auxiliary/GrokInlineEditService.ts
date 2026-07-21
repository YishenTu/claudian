import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { GrokAuxQueryRunner } from '../runtime/GrokAuxQueryRunner';
import type { GrokAuxiliaryLifecycleOptions } from './GrokAuxiliaryLifecycleCoordinator';

export class GrokInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ProviderHost, lifecycleOptions: GrokAuxiliaryLifecycleOptions = {}) {
    super(new GrokAuxQueryRunner(plugin, lifecycleOptions));
  }
}
