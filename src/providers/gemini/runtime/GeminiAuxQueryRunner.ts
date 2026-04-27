import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type ClaudianPlugin from '../../../main';
import { getGeminiProviderSettings } from '../settings';
import { DEFAULT_GEMINI_PRIMARY_MODEL } from '../types/models';
import { GeminiApiClient, type GeminiContent } from './GeminiApiClient';

export interface GeminiAuxQueryConfig {
  systemPrompt: string;
  model?: string;
  abortController?: AbortController;
}

export class GeminiAuxQueryRunner {
  private plugin: ClaudianPlugin;
  private history: GeminiContent[] = [];

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  async query(config: GeminiAuxQueryConfig, prompt: string): Promise<string> {
    const env = getRuntimeEnvironmentVariables(
      this.plugin.settings as unknown as Record<string, unknown>,
      'gemini',
    );
    const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key is missing. Add GEMINI_API_KEY or GOOGLE_API_KEY in Gemini provider environment settings.');
    }

    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'gemini',
    );
    const geminiSettings = getGeminiProviderSettings(providerSettings);
    const model = config.model || (providerSettings.model as string | undefined) || DEFAULT_GEMINI_PRIMARY_MODEL;
    const client = new GeminiApiClient({
      apiKey,
      baseUrl: env.GEMINI_API_BASE_URL || env.GOOGLE_GEMINI_BASE_URL,
    });

    const contents = [
      ...this.history,
      { role: 'user' as const, parts: [{ text: prompt }] },
    ];

    const response = await client.generateText({
      model,
      contents,
      systemInstruction: config.systemPrompt,
      temperature: geminiSettings.temperature,
      signal: config.abortController?.signal,
    });

    this.history = [
      ...contents,
      { role: 'model' as const, parts: [{ text: response.text }] },
    ];

    return response.text;
  }

  reset(): void {
    this.history = [];
  }
}
