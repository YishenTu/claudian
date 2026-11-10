import type { SlashCommand } from '@/core/types';
import { ClaudeCommandCatalog } from '@/providers/claude/commands/ClaudeCommandCatalog';

describe('ClaudeCommandCatalog', () => {
  describe('listDropdownEntries', () => {
    it('returns empty when no runtime commands and no probe', async () => {
      const catalog = new ClaudeCommandCatalog();

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries).toHaveLength(0);
    });

    it('hides Claude Code built-ins except /goal and custom rows their names shadow, keeping skills and custom commands', async () => {
      const catalog = new ClaudeCommandCatalog();

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false, commandSnapshot: [
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk', kind: 'skill' },
        { id: 'sdk:agents', name: 'agents', description: 'Agents', content: '', source: 'builtin' },
        { id: 'sdk:review', name: 'review', description: 'Review', content: '', source: 'builtin' },
        { id: 'sdk:init', name: 'init', description: 'My init', content: '', source: 'sdk' },
        { id: 'sdk:simplify', name: 'simplify', description: 'Shadowed', content: '', source: 'sdk' },
        { id: 'sdk:simplify', name: 'Simplify', description: 'Native', content: '', source: 'builtin' },
        { id: 'sdk:goal', name: 'goal', description: 'Set a goal', content: '', source: 'builtin' },
      ] });

      expect(entries.map(e => e.name)).toEqual(['commit', 'init', 'goal']);
    });

    it('keeps every row of a snapshot without built-in provenance', async () => {
      const catalog = new ClaudeCommandCatalog();

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false, commandSnapshot: [
        { id: 'sdk:cost', name: 'cost', description: 'Cost', content: '', source: 'sdk' },
        { id: 'sdk:init', name: 'init', description: 'Init', content: '', source: 'sdk' },
      ] });

      expect(entries.map(e => e.name)).toEqual(['cost', 'init']);
    });

    it('probes SDK when the request carries no snapshot', async () => {
      const probe = vi.fn().mockResolvedValue([
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
      const probe = vi.fn()
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

    it('does not probe when the request carries a live session snapshot', async () => {
      const probe = vi.fn().mockResolvedValue([]);
      const catalog = new ClaudeCommandCatalog(probe);

      await catalog.listDropdownEntries({ includeBuiltIns: false, commandSnapshot: [
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ] });

      expect(probe).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent probe calls', async () => {
      const probe = vi.fn().mockResolvedValue([
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
      const probe = vi.fn()
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
      const probe = vi.fn()
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
      const probe = vi.fn()
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
  });
});
