import { decodeSessionToolCall, SESSION_TOOL_SPECS } from '@/core/session-tools/sessionToolSpecs';
import { SESSION_TOOLS } from '@/core/tools/toolNames';

describe('session tool specs', () => {
  it('describe both tools with closed JSON Schema inputs and the optional-reply guidance', () => {
    expect(SESSION_TOOL_SPECS.map(spec => spec.name)).toEqual([...SESSION_TOOLS]);
    for (const spec of SESSION_TOOL_SPECS) {
      expect(spec.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    const send = SESSION_TOOL_SPECS.find(spec => spec.name === 'claudian_send_message')!;
    expect(send.inputSchema.required).toEqual(['text']);
    expect(Object.keys(send.inputSchema.properties)).toEqual(['sessionId', 'text', 'provider', 'model', 'reasoning']);
    expect(send.description).toContain('<session_message');
    expect(send.description).toMatch(/only if a response is needed/);
    // Explicit new-session choices point at the listing instead of embedding a stale option list.
    for (const key of ['model', 'reasoning']) {
      expect(send.inputSchema.properties[key]?.description).toMatch(/switches that session's selection, which persists/);
    }
    for (const key of ['provider', 'model', 'reasoning']) {
      expect(send.inputSchema.properties[key]?.description).toContain('claudian_list_destinations with includeProviders: true');
    }
    const list = SESSION_TOOL_SPECS.find(spec => spec.name === 'claudian_list_destinations')!;
    expect(list.inputSchema.properties).toEqual({
      includeProviders: expect.objectContaining({ type: 'boolean' }),
      limit: expect.objectContaining({ type: 'integer' }),
    });
    expect(list.inputSchema.required).toBeUndefined();
  });
});

describe('decodeSessionToolCall', () => {
  it.each([
    ['list with no arguments', 'claudian_list_destinations', undefined,
      { tool: 'claudian_list_destinations', args: { includeProviders: false, limit: 50 } }],
    ['list with empty arguments', 'claudian_list_destinations', {},
      { tool: 'claudian_list_destinations', args: { includeProviders: false, limit: 50 } }],
    ['list with providers and a limit', 'claudian_list_destinations', { includeProviders: true, limit: 200 },
      { tool: 'claudian_list_destinations', args: { includeProviders: true, limit: 200 } }],
    ['list treating null optionals as omitted', 'claudian_list_destinations', { includeProviders: null, limit: null },
      { tool: 'claudian_list_destinations', args: { includeProviders: false, limit: 50 } }],
    ['send to a session', 'claudian_send_message', { sessionId: 'conv-1', text: 'Hi' },
      { tool: 'claudian_send_message', args: { sessionId: 'conv-1', text: 'Hi' } }],
    ['send to a new session with provider and model', 'claudian_send_message',
      { text: 'Hi', provider: 'codex', model: 'gpt-5' },
      { tool: 'claudian_send_message', args: { text: 'Hi', provider: 'codex', model: 'gpt-5' } }],
    ['send switching an existing session\'s model and reasoning', 'claudian_send_message',
      { sessionId: 'conv-1', text: 'Hi', model: 'gpt-5', reasoning: 'low' },
      { tool: 'claudian_send_message', args: { sessionId: 'conv-1', text: 'Hi', model: 'gpt-5', reasoning: 'low' } }],
    ['send to a new session with model and reasoning', 'claudian_send_message',
      { text: 'Hi', model: 'gpt-5', reasoning: 'low' },
      { tool: 'claudian_send_message', args: { text: 'Hi', model: 'gpt-5', reasoning: 'low' } }],
    ['send treating null optionals as omitted', 'claudian_send_message',
      { sessionId: null, text: 'Hi', provider: null, model: null, reasoning: null },
      { tool: 'claudian_send_message', args: { text: 'Hi' } }],
  ])('decodes %s', (_label, name, args, call) => {
    expect(decodeSessionToolCall(name, args)).toEqual({ ok: true, call });
  });

  it.each([
    ['an unknown tool', 'send_message', { text: 'Hi' }, /unknown session tool/i],
    ['non-object arguments', 'claudian_send_message', '{"text":"Hi"}', /arguments must be an object/i],
    ['array arguments', 'claudian_list_destinations', [], /arguments must be an object/i],
    ['unexpected list arguments', 'claudian_list_destinations', { sessionId: 'x' }, /unexpected argument "sessionId"/i],
    ['a non-boolean includeProviders', 'claudian_list_destinations', { includeProviders: 'true' }, /"includeProviders" must be a boolean/],
    ['a zero limit', 'claudian_list_destinations', { limit: 0 }, /"limit" must be an integer from 1 to 200/],
    ['an oversized limit', 'claudian_list_destinations', { limit: 201 }, /"limit" must be an integer from 1 to 200/],
    ['a fractional limit', 'claudian_list_destinations', { limit: 2.5 }, /"limit" must be an integer from 1 to 200/],
    ['a string limit', 'claudian_list_destinations', { limit: '10' }, /"limit" must be an integer from 1 to 200/],
    ['unexpected send arguments', 'claudian_send_message', { text: 'Hi', to: 'x' }, /unexpected argument "to"/i],
    ['missing text', 'claudian_send_message', { sessionId: 'conv-1' }, /"text" must be a non-empty string/],
    ['blank text', 'claudian_send_message', { text: '  \n' }, /"text" must be a non-empty string/],
    ['a non-string session id', 'claudian_send_message', { sessionId: 7, text: 'Hi' }, /"sessionId" must be a non-empty string/],
    ['an empty provider', 'claudian_send_message', { text: 'Hi', provider: '' }, /"provider" must be a non-empty string/],
    ['provider for an existing session', 'claudian_send_message', { sessionId: 'conv-1', text: 'Hi', provider: 'codex' },
      /"provider" applies only when "sessionId" is omitted/],
    ['provider with model for an existing session', 'claudian_send_message',
      { sessionId: 'conv-1', text: 'Hi', provider: 'claude', model: 'm' }, /"provider" applies only when "sessionId" is omitted/],
    ['an empty reasoning', 'claudian_send_message', { text: 'Hi', reasoning: ' ' }, /"reasoning" must be a non-empty string/],
    ['a provider without a model', 'claudian_send_message', { text: 'Hi', provider: 'codex' }, /"provider" requires "model"/],
    ['a provider with only reasoning', 'claudian_send_message', { text: 'Hi', provider: 'codex', reasoning: 'high' }, /"provider" requires "model"/],
  ])('rejects %s', (_label, name, args, error) => {
    const result = decodeSessionToolCall(name, args);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(error);
  });
});
