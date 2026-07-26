import { createMockEl } from '@test/helpers/mockElement';
import { Notice } from 'obsidian';

import {
  KIMI_BRAND_AGENTS_PATH,
  KIMI_GENERIC_AGENTS_PATH,
  type KimiAgentDefinition,
} from '@/providers/kimi/agents/KimiAgentStorage';
import {
  findKimiAgentNameConflict,
  KimiAgentSettings,
  resolveKimiModelPreference,
} from '@/providers/kimi/ui/KimiAgentSettings';

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirmDelete: jest.fn(async () => true),
}));

function makeAgent(overrides: Partial<KimiAgentDefinition> = {}): KimiAgentDefinition {
  return {
    description: 'Reviews code.',
    filePath: `${KIMI_BRAND_AGENTS_PATH}/code-reviewer.md`,
    name: 'code-reviewer',
    prompt: 'Review carefully.',
    ...overrides,
  };
}

function createHarness(agents: KimiAgentDefinition[] = []) {
  const storage = {
    loadAll: jest.fn(async () => agents),
    save: jest.fn(async () => {}),
    delete: jest.fn(async () => {}),
  };
  const onChanged = jest.fn(async () => {});
  const settings = new KimiAgentSettings(
    createMockEl('div') as unknown as HTMLElement,
    {
      app: {} as never,
      onChanged,
      storage: storage as never,
    },
  );
  return { onChanged, settings, storage };
}

// Lets the constructor-triggered async render settle without racing a second one.
function flushRender(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('resolveKimiModelPreference', () => {
  it('maps the dropdown values onto model_preference', () => {
    expect(resolveKimiModelPreference('inherit')).toBeUndefined();
    expect(resolveKimiModelPreference('primary')).toBe('primary');
    expect(resolveKimiModelPreference('secondary')).toBe('secondary');
    expect(resolveKimiModelPreference('anything-else')).toBeUndefined();
  });
});

describe('findKimiAgentNameConflict', () => {
  it('detects duplicates across both directories but ignores the edited file', () => {
    const agents = [
      makeAgent(),
      makeAgent({
        filePath: `${KIMI_GENERIC_AGENTS_PATH}/note-auditor.md`,
        name: 'note-auditor',
      }),
    ];

    expect(findKimiAgentNameConflict(agents, 'NOTE-AUDITOR')?.name).toBe('note-auditor');
    expect(findKimiAgentNameConflict(
      agents,
      'note-auditor',
      `${KIMI_GENERIC_AGENTS_PATH}/note-auditor.md`,
    )).toBeNull();
    expect(findKimiAgentNameConflict(agents, 'fresh-agent')).toBeNull();
  });
});

describe('KimiAgentSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the stored agents and an empty-state hint', async () => {
    const { settings } = createHarness([
      makeAgent(),
      makeAgent({
        filePath: `${KIMI_GENERIC_AGENTS_PATH}/note-auditor.md`,
        name: 'note-auditor',
        description: 'Audits vault notes.',
      }),
    ]);

    await flushRender();
    const names = Array.from(
      (settings as any).containerEl.querySelectorAll('.claudian-sp-item-name'),
    ).map((el: any) => el.textContent);
    expect(names).toEqual(['code-reviewer', 'note-auditor']);

    const empty = createHarness([]);
    await flushRender();
    expect(
      (empty.settings as any).containerEl.querySelector('.claudian-sp-empty-state'),
    ).not.toBeNull();
  });

  it('saves edits in place and renames with old-file cleanup in the brand directory', async () => {
    const { settings, storage, onChanged } = createHarness();

    const existing = makeAgent();
    await (settings as any).saveAgent({ ...existing, description: 'Updated.' }, existing);
    expect(storage.save).toHaveBeenCalledWith({ ...existing, description: 'Updated.' }, existing);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();

    storage.save.mockClear();
    const renamed = { ...existing, name: 'new-name' };
    await (settings as any).saveAgent(renamed, existing);
    expect(storage.save).toHaveBeenCalledWith(renamed, existing);
  });

  it('does not delete the generic-directory file when editing a generic agent', async () => {
    const { settings, storage } = createHarness();
    const generic = makeAgent({
      filePath: `${KIMI_GENERIC_AGENTS_PATH}/note-auditor.md`,
      name: 'note-auditor',
    });

    await (settings as any).saveAgent(generic, generic);

    expect(storage.save).toHaveBeenCalledWith(generic, generic);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('deletes through storage after confirmation and refreshes mentions', async () => {
    const { settings, storage, onChanged } = createHarness([makeAgent()]);
    await flushRender();

    await (settings as any).deleteAgent(makeAgent());

    expect(storage.delete).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    expect(Notice).toHaveBeenCalled();
  });
});
