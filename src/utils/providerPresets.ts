/**
 * Built-in provider presets for Anthropic API-compatible services.
 *
 * Users can one-click apply these to configure third-party model providers
 * that speak the Anthropic API format.
 */

export interface ProviderPreset {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** Environment variables to apply (KEY=VALUE, one per line) */
  envVars: string;
  /** Optional context window limits for the preset models */
  contextLimits?: Record<string, number>;
  /** Documentation URL */
  docsUrl: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax M2.7 (204K context) via Anthropic-compatible API',
    envVars: [
      'ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic',
      'ANTHROPIC_API_KEY=your-minimax-api-key',
      'ANTHROPIC_MODEL=MiniMax-M2.7',
    ].join('\n'),
    contextLimits: { 'MiniMax-M2.7': 204_000 },
    docsUrl: 'https://platform.minimaxi.com',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Access multiple models via OpenRouter',
    envVars: [
      'ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1',
      'ANTHROPIC_API_KEY=your-openrouter-api-key',
      'ANTHROPIC_MODEL=anthropic/claude-sonnet-4',
    ].join('\n'),
    docsUrl: 'https://openrouter.ai/docs/guides/claude-code-integration',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek V3 via Anthropic-compatible API',
    envVars: [
      'ANTHROPIC_BASE_URL=https://api.deepseek.com',
      'ANTHROPIC_API_KEY=your-deepseek-api-key',
      'ANTHROPIC_MODEL=deepseek-chat',
    ].join('\n'),
    docsUrl: 'https://api-docs.deepseek.com/guides/anthropic_api',
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    description: 'Kimi models via Anthropic-compatible API',
    envVars: [
      'ANTHROPIC_BASE_URL=https://api.moonshot.cn',
      'ANTHROPIC_API_KEY=your-moonshot-api-key',
      'ANTHROPIC_MODEL=moonshot-v1-auto',
    ].join('\n'),
    docsUrl: 'https://platform.moonshot.ai/docs/guide/agent-support',
  },
  {
    id: 'glm',
    name: 'GLM (Zhipu AI)',
    description: 'GLM models via Anthropic-compatible API',
    envVars: [
      'ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/paas/v4',
      'ANTHROPIC_API_KEY=your-zhipu-api-key',
      'ANTHROPIC_MODEL=glm-4-plus',
    ].join('\n'),
    docsUrl: 'https://docs.z.ai/devpack/tool/claude',
  },
];

/** Look up a provider preset by its ID. */
export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id === id);
}
