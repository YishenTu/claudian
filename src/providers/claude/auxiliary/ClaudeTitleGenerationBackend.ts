import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  TitleGenerationBackend,
  TitleGenerationBackendRequest,
} from '../../../core/providers/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { toClaudeRuntimeModelId } from '../modelSelection';
import { runColdStartQuery } from '../runtime/claudeColdStartQuery';
import { claudeChatUIConfig } from '../ui/ClaudeChatUIConfig';

export class ClaudeTitleGenerationBackend implements TitleGenerationBackend {
  constructor(private readonly plugin: ProviderHost) {}

  async query(request: TitleGenerationBackendRequest): Promise<string> {
    const result = await runColdStartQuery({
      plugin: this.plugin,
      systemPrompt: request.systemPrompt,
      tools: [],
      model: this.resolveTitleModel(),
      thinking: { disabled: true },
      persistSession: false,
      abortController: request.abortController,
    }, request.userPrompt);
    return result.text;
  }

  dispose(): void {
    // The shared abort controller owns cancellation; Claude keeps no reusable runner.
  }

  private resolveTitleModel(): string {
    const envVars = parseEnvironmentVariables(
      this.plugin.getActiveEnvironmentVariables('claude')
    );
    const titleModel = this.plugin.settings.titleGenerationModel;
    if (titleModel && claudeChatUIConfig.ownsModel(
      titleModel,
      this.plugin.settings,
    )) {
      return toClaudeRuntimeModelId(titleModel);
    }

    return (
      envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
      'claude-haiku-4-5'
    );
  }
}
