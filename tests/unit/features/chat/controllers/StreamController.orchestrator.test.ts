import { extractOrchestratorPlan } from '@/features/chat/rendering/orchestratorPlanParser';

// Test the pure detection logic only — StreamController wiring is integration territory.
describe('orchestrator plan detection', () => {
  it('detects a plan block inside assistant message content', () => {
    const plan = {
      type: 'orchestrator_plan',
      tasks: [
        { id: '1', description: 'Research', prompt: 'Search the vault.' },
      ],
    };
    const content = `I will break this into tasks:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;
    const result = extractOrchestratorPlan(content);
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
  });

  it('returns null when the assistant message has no plan block', () => {
    expect(extractOrchestratorPlan('Just a regular response.')).toBeNull();
  });
});
