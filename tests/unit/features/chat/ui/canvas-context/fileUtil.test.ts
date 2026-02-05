import { getNodeSummary, readFileContent, readNodeContent } from '@/features/chat/ui/canvas-context/fileUtil';

// Mock resolveSubpath from obsidian
jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  resolveSubpath: jest.fn((cache, subpath) => {
    if (subpath === '#heading1') {
      return { start: { offset: 0 }, end: { offset: 20 } };
    }
    if (subpath === '#noend') {
      return { start: { offset: 5 } };
    }
    return null;
  }),
}));

describe('fileUtil', () => {
  describe('getNodeSummary', () => {
    it('should return text content for text node', () => {
      const node = {
        getData: () => ({ type: 'text', text: 'Hello world' }),
      };

      expect(getNodeSummary(node as any)).toBe('Hello world');
    });

    it('should truncate long text with ellipsis', () => {
      const longText = 'A'.repeat(100);
      const node = {
        getData: () => ({ type: 'text', text: longText }),
      };

      const summary = getNodeSummary(node as any, 50);
      expect(summary).toHaveLength(53); // 50 + '...'
      expect(summary.endsWith('...')).toBe(true);
    });

    it('should respect custom maxLength', () => {
      const node = {
        getData: () => ({ type: 'text', text: 'Hello world, this is a test' }),
      };

      const summary = getNodeSummary(node as any, 10);
      expect(summary).toBe('Hello worl...');
    });

    it('should return filename for file node', () => {
      const node = {
        getData: () => ({ type: 'file', file: 'notes/subfolder/myfile.md' }),
      };

      expect(getNodeSummary(node as any)).toBe('myfile.md');
    });

    it('should return "File" for file node without path', () => {
      const node = {
        getData: () => ({ type: 'file', file: undefined }),
      };

      expect(getNodeSummary(node as any)).toBe('File');
    });

    it('should return URL for link node', () => {
      const node = {
        getData: () => ({ type: 'link', url: 'https://example.com' }),
      };

      expect(getNodeSummary(node as any)).toBe('https://example.com');
    });

    it('should return "Link" for link node without URL', () => {
      const node = {
        getData: () => ({ type: 'link', url: undefined }),
      };

      expect(getNodeSummary(node as any)).toBe('Link');
    });

    it('should return label for group node', () => {
      const node = {
        getData: () => ({ type: 'group', label: 'My Group' }),
      };

      expect(getNodeSummary(node as any)).toBe('My Group');
    });

    it('should return "Group" for group node without label', () => {
      const node = {
        getData: () => ({ type: 'group', label: undefined }),
      };

      expect(getNodeSummary(node as any)).toBe('Group');
    });

    it('should return "Node" for unknown node type', () => {
      const node = {
        getData: () => ({ type: 'unknown' }),
      };

      expect(getNodeSummary(node as any)).toBe('Node');
    });

    it('should trim whitespace from text content', () => {
      const node = {
        getData: () => ({ type: 'text', text: '  Hello world  ' }),
      };

      expect(getNodeSummary(node as any)).toBe('Hello world');
    });

    it('should handle empty text', () => {
      const node = {
        getData: () => ({ type: 'text', text: '' }),
      };

      expect(getNodeSummary(node as any)).toBe('');
    });

    it('should handle null text', () => {
      const node = {
        getData: () => ({ type: 'text', text: null }),
      };

      expect(getNodeSummary(node as any)).toBe('');
    });
  });

  describe('readFileContent', () => {
    it('should read file content without subpath', async () => {
      const mockApp = {
        vault: {
          read: jest.fn().mockResolvedValue('Full file content'),
        },
        metadataCache: {
          getFileCache: jest.fn(),
        },
      };
      const mockFile = { path: 'test.md' };

      const result = await readFileContent(mockApp as any, mockFile as any);
      expect(result).toBe('Full file content');
      expect(mockApp.vault.read).toHaveBeenCalledWith(mockFile);
    });

    it('should extract subpath content when present', async () => {
      const mockApp = {
        vault: {
          read: jest.fn().mockResolvedValue('# Heading1\nContent here'),
        },
        metadataCache: {
          getFileCache: jest.fn().mockReturnValue({ headings: [] }),
        },
      };
      const mockFile = { path: 'test.md' };

      const result = await readFileContent(mockApp as any, mockFile as any, '#heading1');
      expect(result).toBe('# Heading1\nContent h'); // Sliced 0-20
    });

    it('should return full content when subpath not found', async () => {
      const mockApp = {
        vault: {
          read: jest.fn().mockResolvedValue('Full file content'),
        },
        metadataCache: {
          getFileCache: jest.fn().mockReturnValue({ headings: [] }),
        },
      };
      const mockFile = { path: 'test.md' };

      const result = await readFileContent(mockApp as any, mockFile as any, '#nonexistent');
      expect(result).toBe('Full file content');
    });

    it('should return full content when cache is null', async () => {
      const mockApp = {
        vault: {
          read: jest.fn().mockResolvedValue('Full file content'),
        },
        metadataCache: {
          getFileCache: jest.fn().mockReturnValue(null),
        },
      };
      const mockFile = { path: 'test.md' };

      const result = await readFileContent(mockApp as any, mockFile as any, '#heading');
      expect(result).toBe('Full file content');
    });
  });

  describe('readNodeContent', () => {
    it('should return text for text node', async () => {
      const node = {
        app: {},
        getData: () => ({ type: 'text', text: 'Hello world' }),
      };

      const result = await readNodeContent(node as any);
      expect(result).toBe('Hello world');
    });

    it('should return null for text node with empty text', async () => {
      const node = {
        app: {},
        getData: () => ({ type: 'text', text: '' }),
      };

      const result = await readNodeContent(node as any);
      expect(result).toBeNull();
    });

    it('should return null for text node with undefined text', async () => {
      const node = {
        app: {},
        getData: () => ({ type: 'text', text: undefined }),
      };

      const result = await readNodeContent(node as any);
      expect(result).toBeNull();
    });

    it('should return URL for link node', async () => {
      const node = {
        app: {},
        getData: () => ({ type: 'link', url: 'https://example.com' }),
      };

      const result = await readNodeContent(node as any);
      expect(result).toBe('[Link: https://example.com]');
    });

    it('should return null for link node without URL', async () => {
      const node = {
        app: {},
        getData: () => ({ type: 'link', url: undefined }),
      };

      const result = await readNodeContent(node as any);
      expect(result).toBeNull();
    });

    it('should return label for group node', async () => {
      const node = {
        app: {},
        getData: () => ({ type: 'group', label: 'My Group' }),
      };

      const result = await readNodeContent(node as any);
      expect(result).toBe('[Group: My Group]');
    });

    it('should return null for group node without label', async () => {
      const node = {
        app: {},
        getData: () => ({ type: 'group', label: undefined }),
      };

      const result = await readNodeContent(node as any);
      expect(result).toBeNull();
    });

    it('should return null for unknown node type', async () => {
      const node = {
        app: {},
        getData: () => ({ type: 'custom' }),
      };

      const result = await readNodeContent(node as any);
      expect(result).toBeNull();
    });

    describe('file nodes', () => {
      it('should read file content for markdown file', async () => {
        const mockFile = {
          extension: 'md',
          path: 'notes/test.md',
          basename: 'test',
        };
        const node = {
          app: {
            vault: {
              adapter: { constructor: class {} },
              getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
              read: jest.fn().mockResolvedValue('File content here'),
            },
          },
          getData: () => ({ type: 'file', file: 'notes/test.md' }),
        };

        const result = await readNodeContent(node as any);
        expect(result).toBe('## test\nFile content here');
      });

      it('should handle file with subpath', async () => {
        const mockFile = {
          extension: 'md',
          path: 'notes/test.md',
          basename: 'test',
        };
        const node = {
          app: {
            vault: {
              adapter: { constructor: class {} },
              getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
              read: jest.fn().mockResolvedValue('# Heading1\nContent here'),
            },
            metadataCache: {
              getFileCache: jest.fn().mockReturnValue({ headings: [] }),
            },
          },
          getData: () => ({ type: 'file', file: 'notes/test.md', subpath: '#heading1' }),
        };

        const result = await readNodeContent(node as any);
        expect(result).toBe('# Heading1\nContent h');
      });

      it('should return null when file not found', async () => {
        const node = {
          app: {
            vault: {
              adapter: { constructor: class {} },
              getAbstractFileByPath: jest.fn().mockReturnValue(null),
            },
          },
          getData: () => ({ type: 'file', file: 'nonexistent.md' }),
        };

        const result = await readNodeContent(node as any);
        expect(result).toBeNull();
      });

      it('should handle image files with base64 encoding', async () => {
        const mockFile = {
          extension: 'png',
          path: 'images/test.png',
          basename: 'test',
        };
        // Create mock binary data
        const mockBinaryData = new Uint8Array([137, 80, 78, 71]).buffer;
        const node = {
          app: {
            vault: {
              adapter: {
                constructor: class {},
                readBinary: jest.fn().mockResolvedValue(mockBinaryData),
              },
              getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
            },
          },
          getData: () => ({ type: 'file', file: 'images/test.png' }),
        };

        const result = await readNodeContent(node as any);
        expect(result).toMatch(/^\[Image: test\] data:image\/png;base64,/);
      });

      it('should handle image load failure gracefully', async () => {
        const mockFile = {
          extension: 'jpg',
          path: 'images/broken.jpg',
          basename: 'broken',
        };
        const node = {
          app: {
            vault: {
              adapter: {
                constructor: class {},
                readBinary: jest.fn().mockRejectedValue(new Error('Read failed')),
              },
              getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
            },
          },
          getData: () => ({ type: 'file', file: 'images/broken.jpg' }),
        };

        const result = await readNodeContent(node as any);
        expect(result).toBe('[Image: broken (load failed: Read failed)]');
      });
    });
  });
});
