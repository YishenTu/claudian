/**
 * Shared module exports.
 */

export {
  SelectableDropdown,
  type SelectableDropdownOptions,
  type SelectableDropdownRenderOptions,
} from './components/SelectableDropdown';
export {
  createSelectionHighlighter,
  hideSelectionHighlight,
  type SelectionHighlighter,
  showSelectionHighlight,
} from './components/SelectionHighlight';
export {
  SlashCommandDropdown,
  type SlashCommandDropdownCallbacks,
  type SlashCommandDropdownOptions,
} from './components/SlashCommandDropdown';
export { CHECK_ICON_SVG, MCP_ICON_SVG } from './icons';
export {
  type McpMentionProvider,
  type MentionDropdownCallbacks,
  MentionDropdownController,
  type MentionDropdownOptions,
} from './mention/MentionDropdownController';
export {
  type ApprovalDecision,
  ApprovalModal,
  type ApprovalModalOptions,
} from './modals/ApprovalModal';
export {
  type InstructionDecision,
  InstructionModal,
  type InstructionModalCallbacks,
} from './modals/InstructionConfirmModal';
