import { claudeSubagentAdapter } from '@/providers/claude/subagentAdapter';

describe('claudeSubagentAdapter', () => {
  it('recognizes Agent without accepting the retired Task alias', () => {
    expect(claudeSubagentAdapter.isSpawnTool('Agent')).toBe(true);
    expect(claudeSubagentAdapter.isSpawnTool('Task')).toBe(false);
  });

  it('continues to recognize TaskOutput as the managed subagent output tool', () => {
    expect(claudeSubagentAdapter.isOutputTool('TaskOutput')).toBe(true);
  });
});
