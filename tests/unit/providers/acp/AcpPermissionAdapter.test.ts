import {
  buildAcpApprovalDecisionOptions,
  mapAcpApprovalDecision,
} from '../../../../src/providers/acp/AcpPermissionAdapter';
import type { AcpPermissionOption } from '../../../../src/providers/acp/types';

const OPTIONS: AcpPermissionOption[] = [
  { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
  { kind: 'allow_always', name: 'Always allow', optionId: 'allow-always' },
  { kind: 'reject_once', name: 'Reject once', optionId: 'reject-once' },
  { kind: 'reject_always', name: 'Always reject', optionId: 'reject-always' },
];

describe('AcpPermissionAdapter', () => {
  it('maps allow decisions to the best matching ACP option', () => {
    expect(mapAcpApprovalDecision('allow', OPTIONS)).toEqual({
      outcome: { optionId: 'allow-once', outcome: 'selected' },
    });
    expect(mapAcpApprovalDecision('allow-always', OPTIONS)).toEqual({
      outcome: { optionId: 'allow-always', outcome: 'selected' },
    });
  });

  it('maps deny decisions and explicit reject selections', () => {
    expect(mapAcpApprovalDecision('deny', OPTIONS)).toEqual({
      outcome: { optionId: 'reject-once', outcome: 'selected' },
    });
    expect(mapAcpApprovalDecision(
      { type: 'select-option', value: 'reject-always' },
      OPTIONS,
    )).toEqual({
      outcome: { optionId: 'reject-always', outcome: 'selected' },
    });
  });

  it('falls back within the same decision family', () => {
    expect(mapAcpApprovalDecision('allow', [OPTIONS[1]])).toEqual({
      outcome: { optionId: 'allow-always', outcome: 'selected' },
    });
    expect(mapAcpApprovalDecision('deny', [OPTIONS[3]])).toEqual({
      outcome: { optionId: 'reject-always', outcome: 'selected' },
    });
  });

  it('returns cancelled when no valid option represents the decision', () => {
    expect(mapAcpApprovalDecision('allow', OPTIONS.slice(2))).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(mapAcpApprovalDecision(
      { type: 'select-option', value: 'missing' },
      OPTIONS,
    )).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(mapAcpApprovalDecision('cancel', OPTIONS)).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('preserves all ACP choices for the approval UI', () => {
    expect(buildAcpApprovalDecisionOptions(OPTIONS)).toEqual([
      { decision: 'allow', label: 'Allow once', value: 'allow-once' },
      { decision: 'allow-always', label: 'Always allow', value: 'allow-always' },
      { label: 'Reject once', value: 'reject-once' },
      { label: 'Always reject', value: 'reject-always' },
    ]);
  });
});
