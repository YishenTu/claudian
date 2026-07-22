import { claudeSubagentAdapter } from '@/providers/claude/subagentAdapter';

describe('claudeSubagentAdapter', () => {
  it.each(['Agent', 'Task'])('recognizes %s as a managed subagent spawn tool', (name) => {
    expect(claudeSubagentAdapter.isSpawnTool(name)).toBe(true);
  });

  it('continues to recognize TaskOutput as the managed subagent output tool', () => {
    expect(claudeSubagentAdapter.isOutputTool('TaskOutput')).toBe(true);
  });
});
