jest.mock('@/shared/components/SelectionHighlight', () => ({
  hideSelectionHighlight: jest.fn(),
  showSelectionHighlight: jest.fn(),
}));

jest.mock('@/shared/icons', () => ({
  CHECK_ICON_SVG: '<svg />',
  MCP_ICON_SVG: '<svg />',
}));

jest.mock('@/shared/modals/InstructionConfirmModal', () => ({
  InstructionModal: function InstructionModal() {},
}));

import { hideSelectionHighlight, showSelectionHighlight } from '@/shared/components/SelectionHighlight';
import {
  ComposerDropdownController,
  MentionSource,
  SlashCommandSource,
} from '@/shared/composer-dropdown';
import { CHECK_ICON_SVG, MCP_ICON_SVG } from '@/shared/icons';
import { InstructionModal } from '@/shared/modals/InstructionConfirmModal';

describe('shared index', () => {
  it('re-exports runtime symbols', () => {
    expect(ComposerDropdownController).toBeDefined();
    expect(showSelectionHighlight).toBeDefined();
    expect(hideSelectionHighlight).toBeDefined();
    expect(SlashCommandSource).toBeDefined();
    expect(MentionSource).toBeDefined();
    expect(InstructionModal).toBeDefined();
    expect(CHECK_ICON_SVG).toBe('<svg />');
    expect(MCP_ICON_SVG).toBe('<svg />');
  });
});
