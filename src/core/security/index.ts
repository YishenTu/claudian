/**
 * Security modules barrel export.
 */

export {
  ApprovalManager,
  getActionDescription,
  getActionPattern,
  matchesPattern,
  type PersistApprovalCallback,
} from './ApprovalManager';
export {
  checkBashPathAccess,
  cleanPathToken,
  extractPathCandidates,
  findBashCommandPathViolation,
  findBashPathViolationInSegment,
  getBashSegmentCommandName,
  isBashInputRedirectOperator,
  isBashOutputOptionExpectingValue,
  isBashOutputRedirectOperator,
  isPathLikeToken,
  type PathCheckContext,
  type PathViolation,
  splitBashTokensIntoSegments,
  tokenizeBashCommand,
} from './BashPathValidator';
export {
  isCommandBlocked,
  validateBlocklistPattern,
} from './BlocklistChecker';
