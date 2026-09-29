import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentOutput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';

import { ClaudeTaskResultInterpreter } from '@/providers/claude/runtime/ClaudeTaskResultInterpreter';

function completedAgentOutput(agentId: string, texts: string[]): AgentOutput {
  return {
    status: 'completed',
    agentId,
    prompt: 'Explain the bookkeeping',
    content: texts.map(text => ({ type: 'text', text })),
    totalToolUseCount: 0,
    totalDurationMs: 1,
    totalTokens: 5,
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  };
}

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

  it.each([
    'Use <result>value</result> in the XML response.',
    '{"result":"example","other":"keep this field"}',
    '{"text":"example","other":"keep this field"}',
    '    indented code\n    next line\n',
    'An ordinary answer mentioning [Subagent hand-back] and agentId: example.',
    '[Subagent hand-back] The text below is the final report of a subagent. The report follows:\nUnindented user content\nagentId: example (metadata)\n<usage>tokens: 1</usage>',
    '[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n  A report with no native trailer.',
  ])('preserves text that does not form a native hand-back envelope', text => {
    expect(new ClaudeTaskResultInterpreter().interpretResult(text, false, { mode: 'sync' }).result).toBe(text);
  });

  it.each(['sync', 'async'] as const)('renders a structured %s AgentOutput report verbatim, including trailer-shaped text', mode => {
    // The SDK documents the structured report as free of the model-directed agentId/usage trailer.
    const report = ['Agent bookkeeping looks like this:', 'agentId: agent-1\n<usage>total_tokens: 5</usage>'];
    const result = new ClaudeTaskResultInterpreter().interpretResult(
      'Model-facing text', false, { mode, agentId: 'agent-1' }, completedAgentOutput('agent-1', report));

    expect(result).toEqual({ status: 'completed', result: report.join('\n') });
  });

  describe('interpretLaunch', () => {
    it('does not treat an 8-hex token in ordinary result text as an agent id', () => {
      const launch = new ClaudeTaskResultInterpreter().interpretLaunch('Fixed in commit deadbeef.', false);

      expect(launch).toEqual({ mode: 'sync', agentId: null, result: 'Fixed in commit deadbeef.' });
    });


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
