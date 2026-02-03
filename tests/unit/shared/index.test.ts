jest.mock('@/shared/components/SelectableDropdown', () => ({
  SelectableDropdown: function SelectableDropdown() {},
}));

jest.mock('@/shared/components/SelectionHighlight', () => ({
  hideSelectionHighlight: jest.fn(),
  showSelectionHighlight: jest.fn(),
}));

jest.mock('@/shared/components/SlashCommandDropdown', () => ({
  SlashCommandDropdown: function SlashCommandDropdown() {},
}));

jest.mock('@/shared/icons', () => ({
  CHECK_ICON_SVG: '<svg />',
  MCP_ICON_SVG: '<svg />',
}));

jest.mock('@/shared/mention/MentionDropdownController', () => ({
  MentionDropdownController: function MentionDropdownController() {},
}));

jest.mock('@/shared/modals/InstructionConfirmModal', () => ({
  InstructionModal: function InstructionModal() {},
}));

import {
  CHECK_ICON_SVG,
  hideSelectionHighlight,
  InstructionModal,
  MCP_ICON_SVG,
  MentionDropdownController,
  SelectableDropdown,
  showSelectionHighlight,
  SlashCommandDropdown,
} from '@/shared';

describe('shared index', () => {
  it('re-exports runtime symbols', () => {
    expect(SelectableDropdown).toBeDefined();
    expect(showSelectionHighlight).toBeDefined();
    expect(hideSelectionHighlight).toBeDefined();
    expect(SlashCommandDropdown).toBeDefined();
    expect(MentionDropdownController).toBeDefined();
    expect(InstructionModal).toBeDefined();
    expect(CHECK_ICON_SVG).toBe('<svg />');
    expect(MCP_ICON_SVG).toBe('<svg />');
  });
});

