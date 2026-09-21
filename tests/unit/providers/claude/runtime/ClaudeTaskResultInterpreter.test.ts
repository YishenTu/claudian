import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeTaskResultInterpreter } from '@/providers/claude/runtime/ClaudeTaskResultInterpreter';

describe('ClaudeTaskResultInterpreter', () => {
  it('waits for partial task input before determining mode', () => {
    const interpreter = new ClaudeTaskResultInterpreter();
    expect(interpreter.describeTask({ description: 'Research' })).toEqual({ mode: null, description: 'Research' });
    expect(interpreter.describeTask({ run_in_background: true, prompt: 'Find details' })).toEqual({ mode: 'async', prompt: 'Find details' });
  });

  it('correlates an output tool and interprets running and completed native envelopes', () => {
    const interpreter = new ClaudeTaskResultInterpreter();
    expect(interpreter.getOutputTaskId({ task_id: 'agent-1' })).toBe('agent-1');
    const running = '{"agents":{"agent-1":{"status":"running"}}}';
    expect(interpreter.getOutputTaskId(undefined, running)).toBe('agent-1');
    expect(interpreter.interpretResult(running, false, { mode: 'async' }))
      .toMatchObject({ status: 'running' });
    expect(interpreter.interpretResult('Unreliable error flag', true, { mode: 'async', agentId: 'agent-1' }, { status: 'completed', task: { result: 'Native answer' } }))
      .toEqual({ status: 'completed', result: 'Native answer' });
  });

  it('recovers a truncated native output file through the provider', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claudian-provider-output-'));
    const outputPath = join(directory, 'task.output');
    writeFileSync(outputPath, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered answer' }] } }));
    try {
      expect(new ClaudeTaskResultInterpreter().interpretResult(`<output>[Truncated. Full output: ${outputPath}]</output>`, false, { mode: 'async' }))
        .toMatchObject({ status: 'completed', result: 'Recovered answer' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not read truncated output outside the trusted temporary roots', () => {
    const directory = mkdtempSync(join(homedir(), '.claudian-provider-untrusted-'));
    const outputPath = join(directory, 'task.output');
    writeFileSync(outputPath, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Untrusted answer' }] } }));
    const marker = `[Truncated. Full output: ${outputPath}]`;
    try {
      expect(new ClaudeTaskResultInterpreter().interpretResult(`<output>${marker}</output>`, false, { mode: 'async' }).result).toBe(marker);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe('interpretLaunch', () => {
    it('does not treat completed sync metadata with agentId as an async launch', () => {
      const interpreter = new ClaudeTaskResultInterpreter();

      expect(interpreter.interpretLaunch('', false, {
        status: 'completed',
        agentId: 'agent-sync',
        content: [
          { type: 'text', text: 'Final sync result.' },
          { type: 'text', text: 'agentId: agent-sync' },
        ],
      }).mode).toBe('sync');
    });

    it('treats explicit async launch markers as async', () => {
      const interpreter = new ClaudeTaskResultInterpreter();

      expect(interpreter.interpretLaunch('', false, {
        isAsync: true,
        status: 'async_launched',
        agentId: 'agent-async',
      }).mode).toBe('async');
    });
  });
});
