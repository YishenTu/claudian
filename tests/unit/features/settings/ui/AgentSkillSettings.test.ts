import type { AgentSkillDocument } from '@/core/skills/AgentSkill';
import {
  AgentSkillCollisionError,
  AgentSkillRevisionConflictError,
} from '@/core/skills/AgentSkillRepository';
import type { AgentSkillManagementCoordinator } from '@/features/settings/AgentSkillManagementCoordinator';
import {
  AgentSkillDeleteModal,
  AgentSkillModal,
  AgentSkillSettings,
} from '@/shared/settings/AgentSkillSettings';

const mockNotices: string[] = [];

interface MockElement {
  attr?: Record<string, string>;
  children: MockElement[];
  cls?: string;
  textContent: string;
  value: string;
  addClass(cls: string): void;
  addEventListener(event: string, listener: () => void): void;
  createDiv(options?: { cls?: string; text?: string }): MockElement;
  createEl(tag: string, options?: { attr?: Record<string, string>; cls?: string; text?: string }): MockElement;
  createSpan(options?: { cls?: string; text?: string }): MockElement;
  empty(): void;
  setText(value: string): void;
}

function createElement(options?: { attr?: Record<string, string>; cls?: string; text?: string }): MockElement {
  const element: MockElement = {
    attr: options?.attr,
    children: [],
    cls: options?.cls,
    textContent: options?.text ?? '',
    value: '',
    addClass: jest.fn(),
    addEventListener: jest.fn(),
    createDiv(childOptions) {
      const child = createElement(childOptions);
      element.children.push(child);
      return child;
    },
    createEl(_tag, childOptions) {
      const child = createElement(childOptions);
      element.children.push(child);
      return child;
    },
    createSpan(childOptions) {
      const child = createElement(childOptions);
      element.children.push(child);
      return child;
    },
    empty() {
      element.children.length = 0;
    },
    setText(value) {
      element.textContent = value;
    },
  };
  return element;
}

interface MockTextComponent {
  inputEl: { value: string };
  setPlaceholder(value: string): MockTextComponent;
  setValue(value: string): MockTextComponent;
}

jest.mock('obsidian', () => ({
  Modal: class MockModal {
    contentEl = createElement();
    modalEl = createElement();
    close = jest.fn();
    open = jest.fn();
    setTitle = jest.fn();
  },
  Notice: class MockNotice {
    constructor(message: string) {
      mockNotices.push(message);
    }
  },
  Setting: class MockSetting {
    setName(_value: string): this { return this; }
    setDesc(_value: string): this { return this; }
    setHeading(): this { return this; }
    addText(callback: (component: MockTextComponent) => void): this {
      const component: MockTextComponent = {
        inputEl: { value: '' },
        setPlaceholder: jest.fn(() => component),
        setValue: jest.fn((value: string) => {
          component.inputEl.value = value;
          return component;
        }),
      };
      callback(component);
      return this;
    }
    addDropdown(): never {
      throw new Error('Shared skill modal must not render a root selector');
    }
  },
  setIcon: jest.fn(),
}));

function makeSkill(overrides: Partial<AgentSkillDocument> = {}): AgentSkillDocument {
  return {
    name: 'shared-skill',
    description: 'Shared description',
    instructions: 'Shared instructions',
    frontmatter: { name: 'shared-skill', description: 'Shared description' },
    directoryPath: '.agents/skills/shared-skill',
    filePath: '.agents/skills/shared-skill/SKILL.md',
    revision: 'revision-1',
    ...overrides,
  };
}

function createCoordinator(skills: AgentSkillDocument[] = [makeSkill()]) {
  return {
    list: jest.fn().mockResolvedValue({
      skills,
      diagnostics: [{ directoryPath: '.agents/skills/broken', message: 'Missing description' }],
    }),
    subscribe: jest.fn().mockReturnValue(jest.fn()),
    create: jest.fn().mockResolvedValue({ value: makeSkill(), refreshFailed: false }),
    update: jest.fn().mockResolvedValue({ value: makeSkill(), refreshFailed: false }),
    trash: jest.fn().mockResolvedValue({ value: undefined, refreshFailed: false }),
  } as unknown as jest.Mocked<AgentSkillManagementCoordinator>;
}

function flattenText(element: MockElement): string {
  return [element.textContent, ...element.children.map(flattenText)].join(' ');
}

describe('AgentSkillModal', () => {
  beforeEach(() => {
    mockNotices.length = 0;
  });

  it('has no storage-root selector and requires portable fields', async () => {
    const onSave = jest.fn().mockResolvedValue({ value: makeSkill(), refreshFailed: false });
    const modal = new AgentSkillModal({} as never, null, onSave);
    modal.onOpen();

    const inputs = modal.getTestInputs();
    inputs.nameInput.value = 'Shared_Skill';
    inputs.descriptionInput.value = '';
    inputs.instructionsArea.value = '';
    await inputs.triggerSave();

    expect(onSave).not.toHaveBeenCalled();
    expect(mockNotices.at(-1)).toContain('lowercase');
    expect(modal.close).not.toHaveBeenCalled();
  });

  it('keeps the edited input open when the loaded revision is stale', async () => {
    const onSave = jest.fn().mockRejectedValue(new AgentSkillRevisionConflictError('shared-skill'));
    const modal = new AgentSkillModal({} as never, makeSkill(), onSave);
    modal.onOpen();
    modal.getTestInputs().instructionsArea.value = 'Unsaved local edit';

    await modal.getTestInputs().triggerSave();

    expect(modal.getTestInputs().instructionsArea.value).toBe('Unsaved local edit');
    expect(modal.close).not.toHaveBeenCalled();
    expect(mockNotices.at(-1)).toBe('This skill changed elsewhere; refresh before saving.');
  });

  it('reports persistence success separately from provider refresh failure', async () => {
    const onSave = jest.fn().mockResolvedValue({ value: makeSkill(), refreshFailed: true });
    const modal = new AgentSkillModal({} as never, null, onSave);
    modal.onOpen();
    const inputs = modal.getTestInputs();
    inputs.nameInput.value = 'shared-skill';
    inputs.descriptionInput.value = 'Shared description';
    inputs.instructionsArea.value = 'Shared instructions';

    await inputs.triggerSave();

    expect(mockNotices.at(-1)).toBe('Saved, but provider refresh failed.');
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('reports collisions without closing or retrying the modal', async () => {
    const onSave = jest.fn().mockRejectedValue(new AgentSkillCollisionError('shared-skill'));
    const modal = new AgentSkillModal({} as never, null, onSave);
    modal.onOpen();
    const inputs = modal.getTestInputs();
    inputs.nameInput.value = 'shared-skill';
    inputs.descriptionInput.value = 'Shared description';
    inputs.instructionsArea.value = 'Shared instructions';

    await inputs.triggerSave();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(modal.close).not.toHaveBeenCalled();
    expect(mockNotices.at(-1)).toBe('A skill named "shared-skill" already exists.');
  });

  it('does not expose raw storage paths in failure notices', async () => {
    const onSave = jest.fn().mockRejectedValue(
      new Error('EACCES: /private/vault/.agents/skills/shared-skill/SKILL.md'),
    );
    const modal = new AgentSkillModal({} as never, null, onSave);
    modal.onOpen();
    const inputs = modal.getTestInputs();
    inputs.nameInput.value = 'shared-skill';
    inputs.descriptionInput.value = 'Shared description';
    inputs.instructionsArea.value = 'Shared instructions';

    await inputs.triggerSave();

    expect(mockNotices.at(-1)).toBe(
      'Failed to save shared skill: Unexpected storage error',
    );
    expect(mockNotices.at(-1)).not.toContain('/private/vault');
  });
});

describe('AgentSkillSettings', () => {
  beforeEach(() => {
    mockNotices.length = 0;
  });

  it('renders one provider-neutral shared location description and diagnostics', async () => {
    const container = createElement();
    const coordinator = createCoordinator();
    new AgentSkillSettings(
      container as unknown as HTMLElement,
      coordinator,
      {} as never,
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    const text = flattenText(container);

    expect(text).toContain('.agents/skills');
    expect(text).toContain('shared-skill');
    expect(text).not.toContain('$shared-skill');
    expect(text).toContain(
      'Manage skills shared across all enabled providers in .agents/skills/.',
    );
    expect(text).not.toMatch(/Shared skills\s+\.agents\/skills\s+/);
    expect(text).not.toContain('provider compatibility issue');
    expect(text).toContain('.agents/skills/broken');
    expect(text).toContain('Missing description');
    expect(coordinator.subscribe).toHaveBeenCalledTimes(1);
  });

  it('preserves provider settings rendered beside the embedded manager', async () => {
    const container = createElement();
    const providerSetting = container.createDiv({
      cls: 'provider-setting',
      text: 'Provider setup remains visible',
    });
    const coordinator = createCoordinator();

    const settings = new AgentSkillSettings(
      container as unknown as HTMLElement,
      coordinator,
      {} as never,
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    await settings.refresh();

    expect(container.children).toContain(providerSetting);
    expect(flattenText(container)).toContain('Provider setup remains visible');
    expect(flattenText(container)).toContain('.agents/skills');
  });
});

describe('AgentSkillDeleteModal', () => {
  it('confirms that the whole package and ancillary files move to trash', () => {
    const modal = new AgentSkillDeleteModal({} as never, makeSkill(), jest.fn());
    modal.onOpen();

    expect(flattenText(modal.contentEl as unknown as MockElement)).toContain(
      'The entire skill folder, including scripts, references, and assets, will be moved to trash.',
    );
  });
});
