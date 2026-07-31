import type {
  TitleGenerationBackend,
  TitleGenerationBackendRequest,
} from '../providers/types';
import type { AuxQueryRunner } from './AuxQueryRunner';

export class AuxQueryTitleGenerationBackend implements TitleGenerationBackend {
  constructor(
    private readonly runner: AuxQueryRunner,
    private readonly resolveModel?: () => string | undefined,
  ) {}

  query(request: TitleGenerationBackendRequest): Promise<string> {
    return this.runner.query({
      abortController: request.abortController,
      model: this.resolveModel?.(),
      systemPrompt: request.systemPrompt,
    }, request.userPrompt);
  }

  dispose(): void {
    this.runner.reset();
  }
}
