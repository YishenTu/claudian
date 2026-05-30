import { buildPiSetModelPayload } from '@/providers/pi/runtime/PiRpcPayloads';

describe('Pi RPC payload builders', () => {
  it('uses Pi RPC modelId field for set_model payloads', () => {
    expect(buildPiSetModelPayload('pi:openai-codex/gpt-5.2')).toEqual({
      modelId: 'gpt-5.2',
      provider: 'openai-codex',
    });
  });

  it('rejects invalid Pi model ids', () => {
    expect(buildPiSetModelPayload('openai-codex/gpt-5.2')).toBeNull();
    expect(buildPiSetModelPayload('pi:openai-codex')).toBeNull();
  });
});
