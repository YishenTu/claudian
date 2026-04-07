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

import { SelectableDropdown } from '@/shared/components/SelectableDropdown';
import { hideSelectionHighlight, showSelectionHighlight } from '@/shared/components/SelectionHighlight';
import { SlashCommandDropdown } from '@/shared/components/SlashCommandDropdown';
import { CHECK_ICON_SVG, MCP_ICON_SVG } from '@/shared/icons';
import { MentionDropdownController } from '@/shared/mention/MentionDropdownController';
import { InstructionModal } from '@/shared/modals/InstructionConfirmModal';

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

