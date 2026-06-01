import { buildSystemPrompt } from '@/core/prompt/mainAgent';

describe('buildSystemPrompt orchestrator mode', () => {
  it('does not include the orchestrator section when orchestratorMode is absent', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toContain('orchestrator_plan');
  });

  it('includes the orchestrator section when orchestratorMode is true', () => {
    const prompt = buildSystemPrompt({}, { orchestratorMode: true });
    expect(prompt).toContain('orchestrator_plan');
    expect(prompt).toContain('"type": "orchestrator_plan"');
  });

  it('does not include the orchestrator section when orchestratorMode is false', () => {
    const prompt = buildSystemPrompt({}, { orchestratorMode: false });
    expect(prompt).not.toContain('orchestrator_plan');
  });
});
