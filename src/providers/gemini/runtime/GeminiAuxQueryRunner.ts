import { GoogleGenerativeAI } from '@google/generative-ai';

import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import type ClaudianPlugin from '../../../main';
import { getGeminiProviderSettings, migrateLegacyGeminiModelId } from '../settings';

export class GeminiAuxQueryRunner implements AuxQueryRunner {
  constructor(private plugin: ClaudianPlugin) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    const settings = getGeminiProviderSettings(this.plugin.settings as unknown as Record<string, unknown>);
    const apiKeyMatch = settings.environmentVariables.match(/GEMINI_API_KEY=([^\n]+)/);
    const apiKey = apiKeyMatch ? apiKeyMatch[1].trim() : process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error('Gemini API Key is not configured.');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelId = migrateLegacyGeminiModelId(
      config.model || settings.visibleModels[0] || 'gemini-2.5-flash',
    );

    const model = genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: config.systemPrompt,
    });

    const chat = model.startChat();

    let accumulatedText = '';
    const result = await chat.sendMessageStream([{ text: prompt }]);

    if (config.abortController?.signal.aborted) {
      throw new Error('Cancelled');
    }

    for await (const chunk of result.stream) {
      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }
      const text = chunk.text();
      accumulatedText += text;
      config.onTextChunk?.(accumulatedText);
    }

    return accumulatedText;
  }

  reset(): void {}
}
