import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { CodexAuxQueryRunner } from '../runtime/CodexAuxQueryRunner';

export class CodexInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ProviderHost) {
    super(new CodexAuxQueryRunner(plugin));
  }
}
