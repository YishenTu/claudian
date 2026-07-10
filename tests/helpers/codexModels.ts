export { CODEX_SPARK_MODEL } from '@/providers/codex/types/models';

export const TEST_CODEX_MODEL = 'gpt-5.5';
export const TEST_CODEX_MODEL_LABEL = 'GPT-5.5';

export const TEST_CODEX_CATALOG = [
  {
    model: TEST_CODEX_MODEL,
    displayName: TEST_CODEX_MODEL_LABEL,
    description: 'Test default Codex model',
    supportedReasoningEfforts: [
      { value: 'low', description: 'Fast' },
      { value: 'medium', description: 'Balanced' },
      { value: 'high', description: 'Deep' },
      { value: 'xhigh', description: 'Extra deep' },
    ],
    defaultReasoningEffort: 'medium',
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
    defaultServiceTier: null,
    inputModalities: ['text', 'image'],
    isDefault: true,
  },
  {
    model: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    description: 'Test smaller Codex model',
    supportedReasoningEfforts: [{ value: 'medium', description: 'Balanced' }],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
    defaultServiceTier: null,
    inputModalities: ['text', 'image'],
    isDefault: false,
  },
];
