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
    expect(Object.keys(send.inputSchema.properties)).toEqual(['sessionId', 'text', 'provider', 'model']);
    expect(send.description).toContain('<session_message');
    expect(send.description).toMatch(/only if a response is needed/);
  });
});

describe('decodeSessionToolCall', () => {
  it.each([
    ['list with no arguments', 'claudian_list_sessions', undefined, { tool: 'claudian_list_sessions' }],
    ['list with empty arguments', 'claudian_list_sessions', {}, { tool: 'claudian_list_sessions' }],
    ['send to a session', 'claudian_send_message', { sessionId: 'conv-1', text: 'Hi' },
      { tool: 'claudian_send_message', args: { sessionId: 'conv-1', text: 'Hi' } }],
    ['send to a new session with provider and model', 'claudian_send_message',
      { text: 'Hi', provider: 'codex', model: 'gpt-5' },
      { tool: 'claudian_send_message', args: { text: 'Hi', provider: 'codex', model: 'gpt-5' } }],
    ['send treating null optionals as omitted', 'claudian_send_message',
      { sessionId: null, text: 'Hi', provider: null, model: null },
      { tool: 'claudian_send_message', args: { text: 'Hi' } }],
  ])('decodes %s', (_label, name, args, call) => {
    expect(decodeSessionToolCall(name, args)).toEqual({ ok: true, call });
  });

  it.each([
    ['an unknown tool', 'send_message', { text: 'Hi' }, /unknown session tool/i],
    ['non-object arguments', 'claudian_send_message', '{"text":"Hi"}', /arguments must be an object/i],
    ['array arguments', 'claudian_list_sessions', [], /arguments must be an object/i],
    ['unexpected list arguments', 'claudian_list_sessions', { sessionId: 'x' }, /unexpected argument "sessionId"/i],
    ['unexpected send arguments', 'claudian_send_message', { text: 'Hi', to: 'x' }, /unexpected argument "to"/i],
    ['missing text', 'claudian_send_message', { sessionId: 'conv-1' }, /"text" must be a non-empty string/],
    ['blank text', 'claudian_send_message', { text: '  \n' }, /"text" must be a non-empty string/],
    ['a non-string session id', 'claudian_send_message', { sessionId: 7, text: 'Hi' }, /"sessionId" must be a non-empty string/],
    ['an empty provider', 'claudian_send_message', { text: 'Hi', provider: '' }, /"provider" must be a non-empty string/],
    ['provider for an existing session', 'claudian_send_message', { sessionId: 'conv-1', text: 'Hi', provider: 'codex' },
      /"provider" and "model" apply only when "sessionId" is omitted/],
    ['model for an existing session', 'claudian_send_message', { sessionId: 'conv-1', text: 'Hi', model: 'm' },
      /"provider" and "model" apply only when "sessionId" is omitted/],
  ])('rejects %s', (_label, name, args, error) => {
    const result = decodeSessionToolCall(name, args);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(error);
  });
});
