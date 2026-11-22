import {
  allowACPPermission,
  buildACPApprovalChoices,
} from '@/providers/acp/ACPPermissionAdapter';
import type { ACPPermissionOption } from '@/providers/acp/types';

const OPTIONS: ACPPermissionOption[] = [
  { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
  { kind: 'allow_always', name: 'Always allow', optionId: 'allow-always' },
  { kind: 'reject_once', name: 'Reject once', optionId: 'reject-once' },
  { kind: 'reject_always', name: 'Always reject', optionId: 'reject-always' },
];

describe('AcpPermissionAdapter', () => {
  it('allows with the one-time option, falling back to the persistent one', () => {
    expect(allowACPPermission(OPTIONS)).toEqual({
      outcome: { optionId: 'allow-once', outcome: 'selected' },
    });
    expect(allowACPPermission([OPTIONS[1], OPTIONS[2]])).toEqual({
      outcome: { optionId: 'allow-always', outcome: 'selected' },
    });
  });

  it('cancels an automatic allow when no option allows', () => {
    expect(allowACPPermission(OPTIONS.slice(2))).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('preserves all ACP choices for the approval UI, each replying with its own option', () => {
    expect(buildACPApprovalChoices(OPTIONS)).toEqual([
      { option: { decision: 'allow', label: 'Allow once', value: 'allow-once' }, reply: { outcome: { optionId: 'allow-once', outcome: 'selected' } } },
      { option: { decision: 'allow-always', label: 'Always allow', value: 'allow-always' }, reply: { outcome: { optionId: 'allow-always', outcome: 'selected' } } },
      { option: { label: 'Reject once', value: 'reject-once' }, reply: { outcome: { optionId: 'reject-once', outcome: 'selected' } } },
      { option: { label: 'Always reject', value: 'reject-always' }, reply: { outcome: { optionId: 'reject-always', outcome: 'selected' } } },
    ]);
  });
});
