import type { ProviderVaultEntryRepository } from '@/core/providers/commands/ProviderVaultEntryRepository';
import { SlashCommandSettings } from '@/providers/claude/ui/SlashCommandSettings';

function createElement(): any {
  const element: any = {
    children: [],
    addEventListener: jest.fn(),
    createDiv: jest.fn(() => {
      const child = createElement();
      element.children.push(child);
      return child;
    }),
    createEl: jest.fn(() => {
      const child = createElement();
      element.children.push(child);
      return child;
    }),
    createSpan: jest.fn(() => {
      const child = createElement();
      element.children.push(child);
      return child;
    }),
    empty: jest.fn(),
    setText: jest.fn(),
  };
  return element;
}

jest.mock('obsidian', () => ({
  Modal: class MockModal {
    contentEl = createElement();
    modalEl = { addClass: jest.fn() };
    close = jest.fn();
    open = jest.fn();
    setTitle = jest.fn();
  },
  Notice: jest.fn(),
  Setting: jest.fn(),
  setIcon: jest.fn(),
}));

describe('SlashCommandSettings', () => {
  it('loads Claude entries through the explicit vault repository', async () => {
    const repository: jest.Mocked<ProviderVaultEntryRepository> = {
      listVaultEntries: jest.fn().mockResolvedValue([]),
      saveVaultEntry: jest.fn().mockResolvedValue(undefined),
      deleteVaultEntry: jest.fn().mockResolvedValue(undefined),
    };

    const settings = new SlashCommandSettings(
      createElement(),
      {} as never,
      repository,
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(settings).toBeInstanceOf(SlashCommandSettings);
    expect(repository.listVaultEntries).toHaveBeenCalledTimes(1);
  });

  it('renders an unavailable state when the Claude repository is absent', async () => {
    const container = createElement();

    new SlashCommandSettings(container, {} as never, null);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(container.createDiv).toHaveBeenCalledWith({ cls: 'claudian-sp-empty-state' });
  });
});
