import { qoderSubagentAdapter } from '@/providers/qoder/subagentAdapter';

describe('qoderSubagentAdapter', () => {
  it('maps Qoder Agent and TaskOutput tools to the shared managed-agent protocol', () => {
    expect(qoderSubagentAdapter.protocol).toBe('managed-agent');
    expect(qoderSubagentAdapter.isSpawnTool('Agent')).toBe(true);
    expect(qoderSubagentAdapter.isSpawnTool('Read')).toBe(false);
    expect(qoderSubagentAdapter.isOutputTool('TaskOutput')).toBe(true);
    expect(qoderSubagentAdapter.isOutputTool('TaskStop')).toBe(false);
  });
});
