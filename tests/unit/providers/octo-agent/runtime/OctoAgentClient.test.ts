import { OctoAgentClient } from '@/providers/octo-agent/runtime/OctoAgentClient';

describe('OctoAgentClient', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('REST calls', () => {
    it('includes the access key on every fetch when configured', async () => {
      const client = new OctoAgentClient({ baseUrl: 'http://127.0.0.1:8088', accessKey: 'Octo_secret' });
      await (client as any).fetchJson('/api/config');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8088/api/config?access_key=Octo_secret',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
    });

    it('does not append an access key when omitted', async () => {
      const client = new OctoAgentClient({ baseUrl: 'http://127.0.0.1:8088' });
      await (client as any).fetchJson('/api/config');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8088/api/config',
        expect.anything(),
      );
    });
  });

  describe('parseEvent', () => {
    let client: OctoAgentClient;

    beforeEach(() => {
      client = new OctoAgentClient({ baseUrl: 'http://127.0.0.1:8088' });
    });

    it('parses text_delta events', () => {
      const event = (client as any).parseEvent({ type: 'text_delta', session_id: 's1', text: 'hello' });
      expect(event).toEqual({ type: 'text_delta', session_id: 's1', text: 'hello' });
    });

    it('parses assistant_message events with content', () => {
      const event = (client as any).parseEvent({
        type: 'assistant_message',
        session_id: 's1',
        content: 'final answer',
        thinking: 'thought',
      });
      expect(event).toEqual({
        type: 'assistant_message',
        session_id: 's1',
        content: 'final answer',
        thinking: 'thought',
      });
    });

    it('defaults missing assistant_message content to an empty string', () => {
      const event = (client as any).parseEvent({
        type: 'assistant_message',
        session_id: 's1',
      });
      expect(event).toEqual({
        type: 'assistant_message',
        session_id: 's1',
        content: '',
      });
    });

    it('parses session_update events', () => {
      const event = (client as any).parseEvent({
        type: 'session_update',
        session_id: 's1',
        context_usage: 1234,
        permission_mode: 'auto',
      });
      expect(event).toEqual({
        type: 'session_update',
        session_id: 's1',
        context_usage: 1234,
        permission_mode: 'auto',
      });
    });

    it('parses history_user_message events', () => {
      const event = (client as any).parseEvent({
        type: 'history_user_message',
        session_id: 's1',
        content: 'previous user message',
      });
      expect(event).toEqual({
        type: 'history_user_message',
        session_id: 's1',
        content: 'previous user message',
      });
    });

    it('marks unknown event types as unknown', () => {
      const raw = { type: 'custom_event', session_id: 's1', value: 42 };
      const event = (client as any).parseEvent(raw);
      expect(event).toEqual({ type: 'unknown', session_id: 's1', raw });
    });
  });
});
