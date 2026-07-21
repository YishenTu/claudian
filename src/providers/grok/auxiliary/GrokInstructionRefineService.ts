import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { GrokAuxQueryRunner } from '../runtime/GrokAuxQueryRunner';
import type { GrokAuxiliaryLifecycleOptions } from './GrokAuxiliaryLifecycleCoordinator';

export class GrokInstructionRefineService extends QueryBackedInstructionRefineService {
  constructor(plugin: ProviderHost, lifecycleOptions: GrokAuxiliaryLifecycleOptions = {}) {
    super(new GrokAuxQueryRunner(plugin, lifecycleOptions));
  }
}
