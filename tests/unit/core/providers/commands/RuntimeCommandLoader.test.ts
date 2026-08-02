import { loadRuntimeCommands } from '@/core/providers/commands/RuntimeCommandLoader';
import type { SlashCommand } from '@/core/types';

const COMMAND: SlashCommand = {
  content: '',
  id: 'runtime:test',
  name: 'test',
  source: 'sdk',
};

function load(
  overrides: Partial<Parameters<typeof loadRuntimeCommands<SlashCommand[]>>[0]> = {},
) {
  return loadRuntimeCommands({
    allowIsolatedMetadataCreation: true,
    discover: async () => [COMMAND],
    errorMessage: 'Could not load commands.',
    projectItems: (commands) => commands,
    requiresSessionMessage: 'Commands require a session.',
    ...overrides,
  });
}

describe('loadRuntimeCommands', () => {
  it('checks cancellation before snapshots or isolated discovery', async () => {
    const controller = new AbortController();
    const failure = new Error('cancelled');
    const discover = jest.fn(async () => [COMMAND]);
    controller.abort(failure);

    await expect(load({
      discover,
      readyCommandSnapshot: [COMMAND],
      signal: controller.signal,
    })).rejects.toBe(failure);
    expect(discover).not.toHaveBeenCalled();
  });

  it('normalizes ready and empty snapshots without isolated discovery', async () => {
    const discover = jest.fn(async () => [COMMAND]);

    await expect(load({ discover, readyCommandSnapshot: [COMMAND] })).resolves.toEqual({
      items: [COMMAND],
      status: 'ready',
    });
    await expect(load({ discover, readyCommandSnapshot: [] })).resolves.toEqual({
      status: 'empty',
    });
    expect(discover).not.toHaveBeenCalled();
  });

  it('returns requires-session without isolated discovery', async () => {
    const discover = jest.fn(async () => [COMMAND]);

    await expect(load({
      allowIsolatedMetadataCreation: false,
      discover,
    })).resolves.toEqual({
      message: 'Commands require a session.',
      status: 'requires-session',
    });
    expect(discover).not.toHaveBeenCalled();
  });

  it('projects isolated discovery and maps failures to a retryable error', async () => {
    await expect(load({
      discover: async () => [{ ...COMMAND, name: 'native' }],
      projectItems: commands => commands.map(command => ({
        ...command,
        name: `projected:${command.name}`,
      })),
    })).resolves.toEqual({
      items: [expect.objectContaining({ name: 'projected:native' })],
      status: 'ready',
    });
    await expect(load({
      discover: async () => { throw new Error('native failure'); },
    })).resolves.toEqual({
      message: 'Could not load commands.',
      retryable: true,
      status: 'error',
    });
    await expect(load({
      projectItems: () => null,
    })).resolves.toEqual({
      message: 'Could not load commands.',
      retryable: true,
      status: 'error',
    });
  });

  it('rechecks cancellation after isolated discovery and still cleans up', async () => {
    const controller = new AbortController();
    const failure = new Error('cancelled after query');
    const cleanup = jest.fn(async () => undefined);

    await expect(load({
      cleanup,
      discover: async () => {
        controller.abort(failure);
        return [COMMAND];
      },
      signal: controller.signal,
    })).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up only after isolated discovery and suppresses cleanup failures', async () => {
    const cleanup = jest.fn(async () => { throw new Error('cleanup failed'); });

    await expect(load({ cleanup })).resolves.toMatchObject({ status: 'ready' });
    expect(cleanup).toHaveBeenCalledTimes(1);

    cleanup.mockClear();
    await expect(load({ cleanup, readyCommandSnapshot: [COMMAND] })).resolves.toMatchObject({
      status: 'ready',
    });
    expect(cleanup).not.toHaveBeenCalled();
  });
});
