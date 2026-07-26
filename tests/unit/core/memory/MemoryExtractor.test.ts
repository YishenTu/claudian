import { MemoryExtractor } from '@/core/memory/MemoryExtractor';
import type { MemoryEntry } from '@/core/memory/types';

describe('MemoryExtractor', () => {
  let extractor: MemoryExtractor;

  beforeEach(() => {
    extractor = new MemoryExtractor();
  });

  describe('trigger word detection', () => {
    it('extracts memory from Chinese "记住" trigger', () => {
      const result = extractor.extract('记住我喜欢用中文交流', []);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('我喜欢用中文交流');
      expect(result.entries[0].source).toBe('user-explicit');
    });

    it('extracts memory from Chinese "请记住" trigger', () => {
      const result = extractor.extract('请记住我的项目使用 TypeScript', []);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('我的项目使用 TypeScript');
    });

    it('extracts memory from Chinese "记得" trigger', () => {
      const result = extractor.extract('记得我偏好暗色主题', []);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('我偏好暗色主题');
    });

    it('extracts memory from Chinese "别忘了" trigger', () => {
      const result = extractor.extract('别忘了我的名字是小明', []);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('我的名字是小明');
    });

    it('extracts memory from English "remember" trigger', () => {
      const result = extractor.extract('remember that I prefer dark mode', []);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('I prefer dark mode');
    });

    it('extracts memory from English "keep in mind" trigger', () => {
      const result = extractor.extract('keep in mind my project uses React', []);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('my project uses React');
    });

    it('extracts memory from English "note that" trigger', () => {
      const result = extractor.extract('note that the deadline is Friday', []);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('the deadline is Friday');
    });
  });

  describe('no extraction for regular messages', () => {
    it('does not extract from normal questions', () => {
      const result = extractor.extract('What is the weather today?', []);
      expect(result.entries).toHaveLength(0);
    });

    it('does not extract from normal statements', () => {
      const result = extractor.extract('I am working on a project', []);
      expect(result.entries).toHaveLength(0);
    });

    it('does not extract from empty messages', () => {
      const result = extractor.extract('', []);
      expect(result.entries).toHaveLength(0);
    });

    it('does not extract when trigger word content is too short', () => {
      const result = extractor.extract('记住ab', []);
      expect(result.entries).toHaveLength(0);
    });
  });

  describe('deduplication', () => {
    it('does not add duplicate entries (exact match)', () => {
      const existing: MemoryEntry[] = [{
        id: 'mem_1',
        category: 'User Preferences',
        content: 'I prefer dark mode',
        source: 'user-explicit',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }];

      const result = extractor.extract('remember that I prefer dark mode', existing);
      expect(result.entries).toHaveLength(0);
    });

    it('does not add entries contained in existing ones', () => {
      const existing: MemoryEntry[] = [{
        id: 'mem_1',
        category: 'User Preferences',
        content: 'I prefer dark mode in all my editors',
        source: 'user-explicit',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }];

      const result = extractor.extract('remember that I prefer dark mode', existing);
      expect(result.entries).toHaveLength(0);
    });

    it('does not add entries that contain existing ones', () => {
      const existing: MemoryEntry[] = [{
        id: 'mem_1',
        category: 'User Preferences',
        content: 'I prefer dark mode',
        source: 'user-explicit',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }];

      const result = extractor.extract('remember that I prefer dark mode in all editors', existing);
      expect(result.entries).toHaveLength(0);
    });

    it('adds entries that are genuinely different', () => {
      const existing: MemoryEntry[] = [{
        id: 'mem_1',
        category: 'User Preferences',
        content: 'I prefer dark mode',
        source: 'user-explicit',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }];

      const result = extractor.extract('remember that I use vim keybindings', existing);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('I use vim keybindings');
    });
  });

  describe('category inference', () => {
    it('infers User Preferences category for preference keywords', () => {
      const result = extractor.extract('记住我喜欢简洁的代码风格', []);
      expect(result.entries[0].category).toBe('User Preferences');
    });

    it('infers Project Context category for project keywords', () => {
      const result = extractor.extract('记住这个项目使用 React 技术栈', []);
      expect(result.entries[0].category).toBe('Project Context');
    });

    it('infers Rules category for rule keywords', () => {
      const result = extractor.extract('remember to always use semicolons', []);
      expect(result.entries[0].category).toBe('Rules');
    });

    it('defaults to User Preferences for unmatched content', () => {
      const result = extractor.extract('remember that the sky is blue', []);
      expect(result.entries[0].category).toBe('User Preferences');
    });
  });

  describe('forget request extraction', () => {
    it('extracts forget request from Chinese "忘记" trigger', () => {
      const result = extractor.extractForgetRequest('忘记我喜欢用中文交流');
      expect(result).toBe('我喜欢用中文交流');
    });

    it('extracts forget request from Chinese "忘掉" trigger', () => {
      const result = extractor.extractForgetRequest('忘掉我的名字是小明');
      expect(result).toBe('我的名字是小明');
    });

    it('extracts forget request from English "forget" trigger', () => {
      const result = extractor.extractForgetRequest('forget that I prefer dark mode');
      expect(result).toBe('I prefer dark mode');
    });

    it('extracts forget request from English "remove memory" trigger', () => {
      const result = extractor.extractForgetRequest('remove the memory about my project');
      expect(result).toBe('about my project');
    });

    it('returns null for non-forget messages', () => {
      const result = extractor.extractForgetRequest('remember that I like coffee');
      expect(result).toBeNull();
    });

    it('returns null for empty messages', () => {
      const result = extractor.extractForgetRequest('');
      expect(result).toBeNull();
    });

    it('returns null when forget content is too short', () => {
      const result = extractor.extractForgetRequest('忘记ab');
      expect(result).toBeNull();
    });
  });

  describe('list request detection', () => {
    it('detects Chinese "列出记忆" trigger', () => {
      expect(extractor.isListRequest('列出记忆')).toBe(true);
    });

    it('detects Chinese "显示所有记忆" trigger', () => {
      expect(extractor.isListRequest('显示所有记忆')).toBe(true);
    });

    it('detects Chinese "查看记忆" trigger', () => {
      expect(extractor.isListRequest('查看记忆')).toBe(true);
    });

    it('detects English "list memories" trigger', () => {
      expect(extractor.isListRequest('list my memories')).toBe(true);
    });

    it('detects English "show memories" trigger', () => {
      expect(extractor.isListRequest('show all my memories')).toBe(true);
    });

    it('detects English "what do you know about me" trigger', () => {
      expect(extractor.isListRequest('what do you know about me')).toBe(true);
    });

    it('returns false for non-list messages', () => {
      expect(extractor.isListRequest('remember that I like coffee')).toBe(false);
    });

    it('returns false for empty messages', () => {
      expect(extractor.isListRequest('')).toBe(false);
    });
  });

  describe('extended category inference', () => {
    it('infers Language category for language keywords', () => {
      const result = extractor.extract('记住我使用中文交流', []);
      expect(result.entries[0].category).toBe('Language');
    });

    it('infers Tools category for tool keywords', () => {
      const result = extractor.extract('记住我常用的编辑器是 VS Code', []);
      expect(result.entries[0].category).toBe('Tools');
    });

    it('infers Environment category for environment keywords', () => {
      const result = extractor.extract('记住我的开发环境配置使用 Node 20', []);
      expect(result.entries[0].category).toBe('Environment');
    });

    it('infers Personal category for name keywords', () => {
      const result = extractor.extract('记住我的名字是小明', []);
      expect(result.entries[0].category).toBe('Personal');
    });
  });
});
