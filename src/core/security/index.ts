/**
 * Security modules barrel export.
 */

export {
  type AddAllowRuleCallback,
  type AddDenyRuleCallback,
  ApprovalManager,
  generatePermissionRule,
  getActionDescription,
  getActionPattern,
  matchesRulePattern,
  type PermissionCheckResult,
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
