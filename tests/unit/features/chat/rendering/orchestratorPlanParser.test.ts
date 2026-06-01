import {
  extractOrchestratorPlan,
  type OrchestratorPlan,
} from '@/features/chat/rendering/orchestratorPlanParser';

const VALID_PLAN: OrchestratorPlan = {
  type: 'orchestrator_plan',
  tasks: [
    { id: '1', description: 'Research vault', prompt: 'Search the vault for notes about X.' },
    { id: '2', description: 'Draft post', prompt: 'Write a blog post about X.' },
  ],
};

const VALID_TEXT = `Here is my plan:\n\`\`\`json\n${JSON.stringify(VALID_PLAN, null, 2)}\n\`\`\`\nPlease approve.`;

describe('extractOrchestratorPlan', () => {
  it('extracts a valid orchestrator_plan block', () => {
    expect(extractOrchestratorPlan(VALID_TEXT)).toEqual(VALID_PLAN);
  });

  it('returns null when no code block is present', () => {
    expect(extractOrchestratorPlan('No plan here.')).toBeNull();
  });

  it('returns null for a code block without type orchestrator_plan', () => {
    const text = '```json\n{"type":"other","tasks":[]}\n```';
    expect(extractOrchestratorPlan(text)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const text = '```json\n{"type":"orchestrator_plan","tasks":[{broken}\n```';
    expect(extractOrchestratorPlan(text)).toBeNull();
  });

  it('returns null for empty task list', () => {
    const text = '```json\n{"type":"orchestrator_plan","tasks":[]}\n```';
    expect(extractOrchestratorPlan(text)).toBeNull();
  });

  it('returns null when a task is missing required fields', () => {
    const text = '```json\n{"type":"orchestrator_plan","tasks":[{"id":"1"}]}\n```';
    expect(extractOrchestratorPlan(text)).toBeNull();
  });

  it('works when the block uses a plain ``` fence (no language tag)', () => {
    const text = `\`\`\`\n${JSON.stringify(VALID_PLAN)}\n\`\`\``;
    expect(extractOrchestratorPlan(text)).toEqual(VALID_PLAN);
  });
});
