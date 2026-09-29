import type { SlashCommand } from '@/core/types';
import { ClaudeCommandCatalog } from '@/providers/claude/commands/ClaudeCommandCatalog';

describe('ClaudeCommandCatalog', () => {
  describe('listDropdownEntries', () => {
    it('returns SDK runtime commands as ProviderCommandEntry', async () => {
      const catalog = new ClaudeCommandCatalog();

      const sdkCommands: SlashCommand[] = [
        { id: 'sdk:commit', name: 'commit', description: 'Create git commit', content: '', source: 'sdk' },
        { id: 'sdk:review', name: 'review', description: 'Review code', content: '', source: 'sdk' },
      ];
      catalog.setCommandSnapshot(sdkCommands);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries).toHaveLength(2);

      const commitEntry = entries.find(e => e.name === 'commit');
      expect(commitEntry).toBeDefined();
      expect(commitEntry!.providerId).toBe('claude');
      expect(commitEntry!.scope).toBe('runtime');
      expect(commitEntry!.source).toBe('sdk');
      expect(commitEntry!.isEditable).toBe(false);
      expect(commitEntry!.isDeletable).toBe(false);
      expect(commitEntry!.displayPrefix).toBe('/');
      expect(commitEntry!.insertPrefix).toBe('/');
    });

    it('returns empty when no runtime commands and no probe', async () => {
      const catalog = new ClaudeCommandCatalog();

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries).toHaveLength(0);
    });

    it('filters out built-in hidden SDK commands', async () => {
      const catalog = new ClaudeCommandCatalog();

      catalog.setCommandSnapshot([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
        { id: 'sdk:init', name: 'init', description: 'Init', content: '', source: 'sdk' },
        { id: 'sdk:debug', name: 'debug', description: 'Debug', content: '', source: 'sdk' },
        { id: 'sdk:cost', name: 'cost', description: 'Cost', content: '', source: 'sdk' },
        { id: 'sdk:review', name: 'review', description: 'Review', content: '', source: 'sdk' },
      ]);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      const names = entries.map(e => e.name);
      expect(names).toEqual(['commit', 'review']);
      expect(names).not.toContain('init');
      expect(names).not.toContain('debug');
      expect(names).not.toContain('cost');
    });

    it('probes SDK on cold start when cache is empty', async () => {
      const probe = jest.fn().mockResolvedValue([
        { id: 'sdk:commit', name: 'commit', description: 'Create git commit', content: '', source: 'sdk' },
      ]);
      const catalog = new ClaudeCommandCatalog(probe);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('commit');
      expect(entries[0].scope).toBe('runtime');
    });

    it('reports a failed probe and probes again on the next request', async () => {
      const probe = jest.fn()
        .mockRejectedValueOnce(new Error('Claude CLI exited'))
        .mockResolvedValueOnce([
          { id: 'sdk:user-skill', name: 'user-skill', description: 'User skill', content: '', source: 'sdk' },
        ]);
      const catalog = new ClaudeCommandCatalog(probe);

      await expect(
        catalog.listDropdownEntries({ includeBuiltIns: false }),
      ).rejects.toThrow('Claude CLI exited');
      await expect(
        catalog.listDropdownEntries({ includeBuiltIns: false }),
      ).resolves.toEqual([
        expect.objectContaining({ name: 'user-skill', scope: 'runtime' }),
      ]);
    });

    it('does not probe when runtime commands are cached', async () => {
      const probe = jest.fn().mockResolvedValue([]);
      const catalog = new ClaudeCommandCatalog(probe);

      catalog.setCommandSnapshot([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);

      await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(probe).not.toHaveBeenCalled();
    });

    it('probes independently when cached runtime fallback is disabled', async () => {
      const probe = jest.fn().mockResolvedValue([
        { id: 'sdk:cold', name: 'cold', description: 'Cold tab command', content: '', source: 'sdk' },
      ]);
      const catalog = new ClaudeCommandCatalog(probe);
      catalog.setCommandSnapshot([
        { id: 'sdk:active', name: 'active', description: 'Active tab command', content: '', source: 'sdk' },
      ]);

      const entries = await catalog.listDropdownEntries({
        includeBuiltIns: false,
        allowCachedCommandSnapshot: false,
      });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(entries.map(entry => entry.name)).toEqual(['cold']);
    });

    it('deduplicates concurrent probe calls', async () => {
      const probe = jest.fn().mockResolvedValue([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);
      const catalog = new ClaudeCommandCatalog(probe);

      const [a, b] = await Promise.all([
        catalog.listDropdownEntries({ includeBuiltIns: false }),
        catalog.listDropdownEntries({ includeBuiltIns: false }),
      ]);

      expect(probe).toHaveBeenCalledTimes(1);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it('aborts and awaits an owned probe while fencing its old-environment result', async () => {
      let releaseOldProbe!: (commands: SlashCommand[]) => void;
      let oldProbeSignal: AbortSignal | undefined;
      const probe = jest.fn()
        .mockImplementationOnce((signal?: AbortSignal) => {
          oldProbeSignal = signal;
          return new Promise<SlashCommand[]>((resolve) => {
            releaseOldProbe = resolve;
          });
        })
        .mockResolvedValueOnce([
          { id: 'sdk:fresh', name: 'fresh', description: 'Fresh', content: '', source: 'sdk' },
        ]);
      const catalog = new ClaudeCommandCatalog(probe);

      const oldRequest = catalog.listDropdownEntries({ includeBuiltIns: false });
      await Promise.resolve();

      let quiesced = false;
      const quiescence = catalog.quiesceForEnvironmentChange().then(() => {
        quiesced = true;
      });

      expect(oldProbeSignal?.aborted).toBe(true);
      await Promise.resolve();
      expect(quiesced).toBe(false);

      await expect(catalog.listDropdownEntries({
        includeBuiltIns: false,
        signal: new AbortController().signal,
      })).resolves.toEqual([]);
      expect(probe).toHaveBeenCalledTimes(1);

      releaseOldProbe([
        { id: 'sdk:old', name: 'old', description: 'Old', content: '', source: 'sdk' },
      ]);
      await expect(oldRequest).resolves.toEqual([]);
      await quiescence;

      await expect(
        catalog.listDropdownEntries({ includeBuiltIns: false }),
      ).resolves.toEqual([
        expect.objectContaining({ name: 'fresh' }),
      ]);
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('clears cached probed commands when the provider environment changes', async () => {
      const probe = jest.fn()
        .mockResolvedValueOnce([
          { id: 'sdk:old', name: 'old', description: 'Old', content: '', source: 'sdk' },
        ])
        .mockResolvedValueOnce([
          { id: 'sdk:fresh', name: 'fresh', description: 'Fresh', content: '', source: 'sdk' },
        ]);
      const catalog = new ClaudeCommandCatalog(probe);

      await expect(
        catalog.listDropdownEntries({ includeBuiltIns: false }),
      ).resolves.toEqual([
        expect.objectContaining({ name: 'old' }),
      ]);

      await catalog.quiesceForEnvironmentChange();

      await expect(
        catalog.listDropdownEntries({ includeBuiltIns: false }),
      ).resolves.toEqual([
        expect.objectContaining({ name: 'fresh' }),
      ]);
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('clears a live command snapshot when the provider environment changes', async () => {
      const probe = jest.fn().mockResolvedValue([
        { id: 'sdk:fresh', name: 'fresh', description: 'Fresh', content: '', source: 'sdk' },
      ]);
      const catalog = new ClaudeCommandCatalog(probe);
      catalog.setCommandSnapshot([
        { id: 'sdk:old', name: 'old', description: 'Old', content: '', source: 'sdk' },
      ]);

      await catalog.quiesceForEnvironmentChange();

      await expect(
        catalog.listDropdownEntries({ includeBuiltIns: false }),
      ).resolves.toEqual([
        expect.objectContaining({ name: 'fresh' }),
      ]);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it('cancels a request-scoped probe and starts fresh work on retry', async () => {
      let resolveFirst!: (commands: SlashCommand[]) => void;
      const firstProbe = new Promise<SlashCommand[]>((resolve) => {
        resolveFirst = resolve;
      });
      const freshCommands: SlashCommand[] = [{
        id: 'sdk:fresh',
        name: 'fresh',
        description: 'Fresh command',
        content: '',
        source: 'sdk',
      }];
      const probe = jest.fn()
        .mockReturnValueOnce(firstProbe)
        .mockResolvedValueOnce(freshCommands);
      const catalog = new ClaudeCommandCatalog(probe);
      const firstController = new AbortController();
      const secondController = new AbortController();

      const abandoned = catalog.listDropdownEntries({
        includeBuiltIns: false,
        signal: firstController.signal,
      });
      firstController.abort();
      const retry = catalog.listDropdownEntries({
        includeBuiltIns: false,
        signal: secondController.signal,
      });
      resolveFirst([]);

      await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
      await expect(retry).resolves.toEqual([
        expect.objectContaining({ name: 'fresh' }),
      ]);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(probe.mock.calls[0][0]).not.toBe(firstController.signal);
      expect(probe.mock.calls[0][0]).toMatchObject({ aborted: true });
      expect(probe.mock.calls[1][0]).not.toBe(secondController.signal);
      expect(probe.mock.calls[1][0]).toMatchObject({ aborted: false });
    });

    it('does not overwrite runtime commands with stale probe results', async () => {

      let resolveProbe: (v: SlashCommand[]) => void;
      const probe = jest.fn().mockReturnValue(new Promise<SlashCommand[]>((r) => { resolveProbe = r; }));
      const catalog = new ClaudeCommandCatalog(probe);

      // Start probe (it will hang)
      const entriesPromise = catalog.listDropdownEntries({ includeBuiltIns: false });

      // Runtime provides fresh data while probe is in-flight
      catalog.setCommandSnapshot([
        { id: 'sdk:review', name: 'review', description: 'Review', content: '', source: 'sdk' },
      ]);

      // Probe returns stale data
      resolveProbe!([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);

      const entries = await entriesPromise;

      // Runtime data wins — probe result is discarded
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('review');
    });
  });

  describe('getDropdownConfig', () => {
    it('returns Claude-specific config', () => {
      const catalog = new ClaudeCommandCatalog();

      const config = catalog.getDropdownConfig();

      expect(config.triggerChars).toEqual(['/']);
      expect(config.builtInPrefix).toBe('/');
      expect(config.skillPrefix).toBe('/');
      expect(config.commandPrefix).toBe('/');
    });
  });
});
