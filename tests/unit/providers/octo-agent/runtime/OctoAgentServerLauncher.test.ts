import { probeOctoAgentServer } from '@/providers/octo-agent/runtime/OctoAgentServerLauncher';

describe('OctoAgentServerLauncher', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('probeOctoAgentServer', () => {
    it('reports running when the health endpoint responds OK', async () => {
      const result = await probeOctoAgentServer('http://127.0.0.1:8088');
      expect(result).toEqual({ running: true });
      expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8088/api/health', { method: 'GET' });
    });

    it('includes the access key on the health probe when provided', async () => {
      const result = await probeOctoAgentServer('http://127.0.0.1:8088', 'Octo_secret');
      expect(result).toEqual({ running: true });
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8088/api/health?access_key=Octo_secret',
        { method: 'GET' },
      );
    });

    it('reports not running when the health endpoint fails', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(new Response('Internal Server Error', { status: 500 })),
      );
      const result = await probeOctoAgentServer('http://127.0.0.1:8088');
      expect(result).toEqual({ running: false });
    });

    it('reports not running when fetch throws', async () => {
      fetchSpy.mockImplementation(() => Promise.reject(new Error('Connection refused')));
      const result = await probeOctoAgentServer('http://127.0.0.1:8088');
      expect(result).toEqual({ running: false });
    });
  });
});
