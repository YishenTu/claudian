import {
  isValidClaudianPermissionMode,
  toClaudianPermissionMode,
  toOctoAgentPermissionMode,
} from '@/providers/octo-agent/permissionMode';

describe('octo-agent permissionMode', () => {
  describe('toOctoAgentPermissionMode', () => {
    it('maps Claudian yolo to octo-agent auto', () => {
      expect(toOctoAgentPermissionMode('yolo')).toBe('auto');
    });

    it('maps Claudian normal to octo-agent interactive', () => {
      expect(toOctoAgentPermissionMode('normal')).toBe('interactive');
    });

    it('maps Claudian plan to octo-agent plan', () => {
      expect(toOctoAgentPermissionMode('plan')).toBe('plan');
    });

    it('falls back to auto for unknown values', () => {
      expect(toOctoAgentPermissionMode('unknown')).toBe('auto');
      expect(toOctoAgentPermissionMode(undefined)).toBe('auto');
    });

    it('passes through server-native values', () => {
      expect(toOctoAgentPermissionMode('auto')).toBe('auto');
      expect(toOctoAgentPermissionMode('interactive')).toBe('interactive');
    });
  });

  describe('toClaudianPermissionMode', () => {
    it('maps octo-agent auto to Claudian yolo', () => {
      expect(toClaudianPermissionMode('auto')).toBe('yolo');
    });

    it('maps octo-agent interactive to Claudian normal', () => {
      expect(toClaudianPermissionMode('interactive')).toBe('normal');
    });

    it('maps octo-agent plan to Claudian plan', () => {
      expect(toClaudianPermissionMode('plan')).toBe('plan');
    });

    it('falls back to yolo for unknown values', () => {
      expect(toClaudianPermissionMode('unknown')).toBe('yolo');
      expect(toClaudianPermissionMode(undefined)).toBe('yolo');
    });

    it('passes through UI-native values', () => {
      expect(toClaudianPermissionMode('yolo')).toBe('yolo');
      expect(toClaudianPermissionMode('normal')).toBe('normal');
    });
  });

  describe('isValidClaudianPermissionMode', () => {
    it('accepts yolo, normal, and plan', () => {
      expect(isValidClaudianPermissionMode('yolo')).toBe(true);
      expect(isValidClaudianPermissionMode('normal')).toBe(true);
      expect(isValidClaudianPermissionMode('plan')).toBe(true);
    });

    it('rejects octo-agent values and unknown strings', () => {
      expect(isValidClaudianPermissionMode('auto')).toBe(false);
      expect(isValidClaudianPermissionMode('interactive')).toBe(false);
      expect(isValidClaudianPermissionMode('')).toBe(false);
      expect(isValidClaudianPermissionMode('unknown')).toBe(false);
    });
  });
});
