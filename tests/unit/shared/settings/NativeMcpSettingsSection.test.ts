import { renderNativeMcpSettingsSection } from '@/shared/settings/NativeMcpSettingsSection';

const createdSettings: Array<{ heading: boolean; name: string }> = [];

jest.mock('obsidian', () => ({
  Setting: class MockSetting {
    public heading = false;
    public name = '';

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setHeading() {
      this.heading = true;
      return this;
    }

    setName(name: string) {
      this.name = name;
      return this;
    }
  },
}));

function createElement(): any {
  return {
    appendText: jest.fn(),
    createEl: jest.fn(() => createElement()),
  };
}

describe('renderNativeMcpSettingsSection', () => {
  beforeEach(() => {
    createdSettings.length = 0;
  });

  it('renders the shared heading, native CLI command, and documentation link', () => {
    const notice = createElement();
    const container = {
      createDiv: jest.fn(() => notice),
    } as unknown as HTMLElement;

    renderNativeMcpSettingsSection(container, {
      descriptionAfterCommand: ' and they will be available in Claudian. ',
      descriptionBeforeCommand: 'Grok Build manages MCP servers through its own CLI. Configure them with ',
      documentationLabel: 'Learn more',
      documentationUrl: 'https://docs.x.ai/build/features/mcp-servers',
      heading: 'MCP Servers',
      setupCommand: 'grok mcp add',
    });

    expect(createdSettings).toEqual([{ heading: true, name: 'MCP Servers' }]);
    expect((container as any).createDiv).toHaveBeenCalledWith({
      cls: 'claudian-mcp-settings-desc',
    });
    expect(notice.createEl).toHaveBeenCalledWith('p', {
      cls: 'setting-item-description',
    });

    const description = notice.createEl.mock.results[0].value;
    expect(description.appendText).toHaveBeenNthCalledWith(
      1,
      'Grok Build manages MCP servers through its own CLI. Configure them with ',
    );
    expect(description.appendText).toHaveBeenNthCalledWith(
      2,
      ' and they will be available in Claudian. ',
    );
    expect(description.createEl).toHaveBeenCalledWith('code');
    expect(description.createEl.mock.results[0].value.appendText)
      .toHaveBeenCalledWith('grok mcp add');
    expect(description.createEl).toHaveBeenCalledWith('a', {
      href: 'https://docs.x.ai/build/features/mcp-servers',
      text: 'Learn more',
    });
  });
});
