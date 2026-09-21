import '@/providers';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { normalizeOpencodeToolInput } from '@/providers/opencode/normalization/opencodeToolNormalization';

it('preserves OpenCode task descriptions and plain output through its registered interpreter', () => {
  const interpreter = ProviderRegistry.getTaskResultInterpreter('opencode');
  const input = normalizeOpencodeToolInput('task', { description: 'Explore notes', prompt: 'Find references', subagent_type: 'explore' });
  expect(interpreter.describeTask(input)).toEqual({ mode: null, description: 'Explore notes', prompt: 'Find references' });
  expect(interpreter.interpretLaunch('References found', false)).toEqual({ mode: 'sync', agentId: null, result: 'References found' });
  expect(interpreter.interpretResult('<result>Literal tool output</result>', false, { mode: 'sync' })).toEqual({ status: 'completed', result: '<result>Literal tool output</result>' });
  expect(interpreter.interpretResult('Task failed', true, { mode: 'sync' }).status).toBe('error');
});
