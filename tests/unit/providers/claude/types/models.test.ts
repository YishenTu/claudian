import { getClaudeProviderSettings } from '@/providers/claude/settings';
import {
  resolveSupportedEffortLevel,
} from '@/providers/claude/types/models';

describe('types.ts', () => {

  describe('legacy provider settings', () => {

    it('should enable Claude by default for backward compatibility', () => {
      expect(getClaudeProviderSettings({ providerConfigs: { claude: {} } }).enabled).toBe(true);
    });
  });

  describe('resolveSupportedEffortLevel', () => {
    it('keeps a reported choice', () => {
      expect(resolveSupportedEffortLevel(['low', 'xhigh'], 'xhigh')).toBe('xhigh');
    });

    it('defaults to High for unsupported or missing choices', () => {
      expect(resolveSupportedEffortLevel(['low', 'high', 'max'], 'xhigh')).toBe('high');
      expect(resolveSupportedEffortLevel(['medium', 'max'], undefined)).toBe('high');
      expect(resolveSupportedEffortLevel(['medium', 'max'], 'invalid')).toBe('high');
    });

    it('has no explicit effort without reported levels', () => {
      expect(resolveSupportedEffortLevel([], 'high')).toBeNull();
    });
  });
});
