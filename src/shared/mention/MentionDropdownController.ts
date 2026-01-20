/**
 * @ mention dropdown controller.
 */

import type { TFile } from 'obsidian';
import { setIcon } from 'obsidian';

import { getFolderName, normalizePathForComparison } from '../../utils/externalContext';
import { type ExternalContextFile, externalContextScanner } from '../../utils/externalContextScanner';
import { extractMcpMentions } from '../../utils/mcp';
import { SelectableDropdown } from '../components/SelectableDropdown';
import { MCP_ICON_SVG } from '../icons';
import {
  type AgentMentionProvider,
  createExternalContextEntry,
  type ExternalContextEntry,
  type MentionItem,
} from './types';

export type { AgentMentionProvider };

export interface MentionDropdownOptions {
  fixed?: boolean;
}

export interface MentionDropdownCallbacks {
  onAttachFile: (path: string) => void;
  /** Attach context file with display name to absolute path mapping. */
  onAttachContextFile?: (displayName: string, absolutePath: string) => void;
  onMcpMentionChange?: (servers: Set<string>) => void;
  /** Called when an agent is selected from the dropdown. */
  onAgentMentionSelect?: (agentId: string) => void;
  getMentionedMcpServers: () => Set<string>;
  setMentionedMcpServers: (mentions: Set<string>) => boolean;
  addMentionedMcpServer: (name: string) => void;
  getExternalContexts: () => string[];
  getCachedMarkdownFiles: () => TFile[];
  normalizePathForVault: (path: string | undefined | null) => string | null;
}

export interface McpMentionProvider {
  getContextSavingServers: () => Array<{ name: string }>;
}

export class MentionDropdownController {
  private containerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement | HTMLInputElement;
  private callbacks: MentionDropdownCallbacks;
  private dropdown: SelectableDropdown<MentionItem>;
  private mentionStartIndex = -1;
  private selectedMentionIndex = 0;
  private filteredMentionItems: MentionItem[] = [];
  private filteredContextFiles: ExternalContextFile[] = [];
  private activeContextFilter: { folderName: string; contextRoot: string } | null = null;
  private activeAgentFilter = false;
  private mcpService: McpMentionProvider | null = null;
  private agentService: AgentMentionProvider | null = null;
  private fixed: boolean;

  constructor(
    containerEl: HTMLElement,
    inputEl: HTMLTextAreaElement | HTMLInputElement,
    callbacks: MentionDropdownCallbacks,
    options: MentionDropdownOptions = {}
  ) {
    this.containerEl = containerEl;
    this.inputEl = inputEl;
    this.callbacks = callbacks;
    this.fixed = options.fixed ?? false;

    this.dropdown = new SelectableDropdown<MentionItem>(this.containerEl, {
      listClassName: 'claudian-mention-dropdown',
      itemClassName: 'claudian-mention-item',
      emptyClassName: 'claudian-mention-empty',
      fixed: this.fixed,
      fixedClassName: 'claudian-mention-dropdown-fixed',
    });
  }

  setMcpService(service: McpMentionProvider | null): void {
    this.mcpService = service;
  }

  setAgentService(service: AgentMentionProvider | null): void {
    this.agentService = service;
  }

  preScanExternalContexts(): void {
    const externalContexts = this.callbacks.getExternalContexts() || [];
    if (externalContexts.length === 0) return;

    setTimeout(() => {
      try {
        externalContextScanner.scanPaths(externalContexts);
      } catch {
        // Pre-scan is best-effort, ignore failures
      }
    }, 0);
  }

  isVisible(): boolean {
    return this.dropdown.isVisible();
  }

  hide(): void {
    this.dropdown.hide();
    this.mentionStartIndex = -1;
  }

  containsElement(el: Node): boolean {
    return this.dropdown.getElement()?.contains(el) ?? false;
  }

  destroy(): void {
    this.dropdown.destroy();
  }

  updateMcpMentionsFromText(text: string): void {
    if (!this.mcpService) return;

    const validNames = new Set(
      this.mcpService.getContextSavingServers().map(s => s.name)
    );

    const newMentions = extractMcpMentions(text, validNames);
    const changed = this.callbacks.setMentionedMcpServers(newMentions);

    if (changed) {
      this.callbacks.onMcpMentionChange?.(newMentions);
    }
  }

  handleInputChange(): void {
    const text = this.inputEl.value;
    this.updateMcpMentionsFromText(text);

    const cursorPos = this.inputEl.selectionStart || 0;
    const textBeforeCursor = text.substring(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      this.hide();
      return;
    }

    const charBeforeAt = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : ' ';
    if (!/\s/.test(charBeforeAt) && lastAtIndex !== 0) {
      this.hide();
      return;
    }

    const searchText = textBeforeCursor.substring(lastAtIndex + 1);

    if (/\s/.test(searchText)) {
      this.hide();
      return;
    }

    this.mentionStartIndex = lastAtIndex;
    this.showMentionDropdown(searchText);
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.dropdown.isVisible()) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.dropdown.moveSelection(1);
      this.selectedMentionIndex = this.dropdown.getSelectedIndex();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.dropdown.moveSelection(-1);
      this.selectedMentionIndex = this.dropdown.getSelectedIndex();
      return true;
    }
    // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
      e.preventDefault();
      this.selectMentionItem();
      return true;
    }
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      this.hide();
      return true;
    }

    return false;
  }

  private buildExternalContextEntries(externalContexts: string[]): ExternalContextEntry[] {
    const counts = new Map<string, number>();
    const normalizedPaths = new Map<string, string>();

    for (const contextPath of externalContexts) {
      const normalized = normalizePathForComparison(contextPath);
      normalizedPaths.set(contextPath, normalized);
      const folderName = getFolderName(normalized);
      counts.set(folderName, (counts.get(folderName) ?? 0) + 1);
    }

    return externalContexts.map(contextRoot => {
      const normalized = normalizedPaths.get(contextRoot) ?? normalizePathForComparison(contextRoot);
      const folderName = getFolderName(contextRoot);
      const needsDisambiguation = (counts.get(folderName) ?? 0) > 1;
      const displayName = this.getContextDisplayName(normalized, folderName, needsDisambiguation);
      return createExternalContextEntry(contextRoot, folderName, displayName);
    });
  }

  private getContextDisplayName(
    normalizedPath: string,
    folderName: string,
    needsDisambiguation: boolean
  ): string {
    if (!needsDisambiguation) return folderName;

    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.length < 2) return folderName;

    const parent = segments[segments.length - 2];
    if (!parent) return folderName;

    return `${parent}/${folderName}`;
  }

  private showMentionDropdown(searchText: string): void {
    const searchLower = searchText.toLowerCase();
    this.filteredMentionItems = [];
    this.filteredContextFiles = [];

    const externalContexts = this.callbacks.getExternalContexts() || [];
    const contextEntries = this.buildExternalContextEntries(externalContexts);

    const isFilterSearch = searchText.includes('/');
    let fileSearchText = searchLower;

    // Check for @Agents/ filter
    if (isFilterSearch && searchLower.startsWith('agents/')) {
      this.activeAgentFilter = true;
      this.activeContextFilter = null;
      const agentSearchText = searchText.substring('agents/'.length).toLowerCase();

      if (this.agentService) {
        const matchingAgents = this.agentService.searchAgents(agentSearchText).slice(0, 10);
        for (const agent of matchingAgents) {
          this.filteredMentionItems.push({
            type: 'agent',
            id: agent.id,
            name: agent.name,
            description: agent.description,
            source: agent.source,
          });
        }
      }

      this.selectedMentionIndex = 0;
      this.renderMentionDropdown();
      return;
    }

    if (isFilterSearch) {
      const matchingContext = contextEntries
        .filter(entry => searchLower.startsWith(`${entry.displayNameLower}/`))
        .sort((a, b) => b.displayNameLower.length - a.displayNameLower.length)[0];

      if (matchingContext) {
        const prefixLength = matchingContext.displayName.length + 1;
        fileSearchText = searchText.substring(prefixLength).toLowerCase();
        this.activeContextFilter = {
          folderName: matchingContext.displayName,
          contextRoot: matchingContext.contextRoot,
        };
      } else {
        this.activeContextFilter = null;
      }
    }

    if (this.activeContextFilter && isFilterSearch) {
      const contextFiles = externalContextScanner.scanPaths([this.activeContextFilter.contextRoot]);
      this.filteredContextFiles = contextFiles
        .filter(file => {
          const relativePath = file.relativePath.replace(/\\/g, '/');
          const pathLower = relativePath.toLowerCase();
          const nameLower = file.name.toLowerCase();
          return pathLower.includes(fileSearchText) || nameLower.includes(fileSearchText);
        })
        .sort((a, b) => {
          const aNameMatch = a.name.toLowerCase().startsWith(fileSearchText);
          const bNameMatch = b.name.toLowerCase().startsWith(fileSearchText);
          if (aNameMatch && !bNameMatch) return -1;
          if (!aNameMatch && bNameMatch) return 1;
          return b.mtime - a.mtime;
        })
        .slice(0, 10);

      for (const file of this.filteredContextFiles) {
        const relativePath = file.relativePath.replace(/\\/g, '/');
        this.filteredMentionItems.push({
          type: 'context-file',
          name: relativePath,
          absolutePath: file.path,
          contextRoot: file.contextRoot,
          folderName: this.activeContextFilter.folderName,
        });
      }

      this.selectedMentionIndex = 0;
      this.renderMentionDropdown();
      return;
    }

    this.activeContextFilter = null;
    this.activeAgentFilter = false;

    if (this.mcpService) {
      const mcpServers = this.mcpService.getContextSavingServers();

      for (const server of mcpServers) {
        if (server.name.toLowerCase().includes(searchLower)) {
          this.filteredMentionItems.push({
            type: 'mcp-server',
            name: server.name,
          });
        }
      }
    }

    // Add @Agents folder entry if there are any agents and it matches the search
    if (this.agentService) {
      const hasAgents = this.agentService.searchAgents('').length > 0;
      if (hasAgents && 'agents'.includes(searchLower)) {
        this.filteredMentionItems.push({
          type: 'agent-folder',
          name: 'Agents',
        });
      }
    }

    if (contextEntries.length > 0) {
      const matchingFolders = new Set<string>();
      for (const entry of contextEntries) {
        if (entry.displayNameLower.includes(searchLower) && !matchingFolders.has(entry.displayName)) {
          matchingFolders.add(entry.displayName);
          this.filteredMentionItems.push({
            type: 'context-folder',
            name: entry.displayName,
            contextRoot: entry.contextRoot,
            folderName: entry.displayName,
          });
        }
      }
    }

    const firstVaultFileIndex = this.filteredMentionItems.length;
    const remainingSlots = 10 - this.filteredMentionItems.length;

    let vaultFiles: TFile[] = [];
    if (remainingSlots > 0) {
      const allFiles = this.callbacks.getCachedMarkdownFiles();
      vaultFiles = allFiles
        .filter(file => {
          const pathLower = file.path.toLowerCase();
          const nameLower = file.name.toLowerCase();
          return pathLower.includes(searchLower) || nameLower.includes(searchLower);
        })
        .sort((a, b) => {
          const aNameMatch = a.name.toLowerCase().startsWith(searchLower);
          const bNameMatch = b.name.toLowerCase().startsWith(searchLower);
          if (aNameMatch && !bNameMatch) return -1;
          if (!aNameMatch && bNameMatch) return 1;
          return b.stat.mtime - a.stat.mtime;
        })
        .slice(0, remainingSlots);

      for (const file of vaultFiles) {
        this.filteredMentionItems.push({
          type: 'file',
          name: file.name,
          path: file.path,
          file,
        });
      }
    }

    if (vaultFiles.length > 0) {
      this.selectedMentionIndex = firstVaultFileIndex;
    } else {
      this.selectedMentionIndex = 0;
    }

    this.renderMentionDropdown();
  }

  private renderMentionDropdown(): void {
    this.dropdown.render({
      items: this.filteredMentionItems,
      selectedIndex: this.selectedMentionIndex,
      emptyText: 'No matches',
      getItemClass: (item) => {
        if (item.type === 'mcp-server') return 'mcp-server';
        if (item.type === 'agent') return 'agent';
        if (item.type === 'agent-folder') return 'agent-folder';
        if (item.type === 'context-file') return 'context-file';
        if (item.type === 'context-folder') return 'context-folder';
        return undefined;
      },
      renderItem: (item, itemEl) => {
        const iconEl = itemEl.createSpan({ cls: 'claudian-mention-icon' });
        if (item.type === 'mcp-server') {
          iconEl.innerHTML = MCP_ICON_SVG;
        } else if (item.type === 'agent' || item.type === 'agent-folder') {
          setIcon(iconEl, 'bot');
        } else if (item.type === 'context-file') {
          setIcon(iconEl, 'folder-open');
        } else if (item.type === 'context-folder') {
          setIcon(iconEl, 'folder');
        } else {
          setIcon(iconEl, 'file-text');
        }

        const textEl = itemEl.createSpan({ cls: 'claudian-mention-text' });

        if (item.type === 'mcp-server') {
          const nameEl = textEl.createSpan({ cls: 'claudian-mention-name' });
          nameEl.setText(`@${item.name}`);
        } else if (item.type === 'agent-folder') {
          const nameEl = textEl.createSpan({
            cls: 'claudian-mention-name claudian-mention-name-agent-folder',
          });
          nameEl.setText(`@${item.name}/`);
        } else if (item.type === 'agent') {
          const nameEl = textEl.createSpan({ cls: 'claudian-mention-name claudian-mention-name-agent' });
          // Show ID (which is namespaced for plugin agents) for consistency with inserted text
          nameEl.setText(`@${item.id}`);
          if (item.description) {
            const descEl = textEl.createSpan({ cls: 'claudian-mention-agent-desc' });
            descEl.setText(item.description);
          }
        } else if (item.type === 'context-folder') {
          const nameEl = textEl.createSpan({
            cls: 'claudian-mention-name claudian-mention-name-folder',
          });
          nameEl.setText(`@${item.name}/`);
        } else if (item.type === 'context-file') {
          const nameEl = textEl.createSpan({
            cls: 'claudian-mention-name claudian-mention-name-context',
          });
          nameEl.setText(item.name);
        } else {
          const pathEl = textEl.createSpan({ cls: 'claudian-mention-path' });
          pathEl.setText(item.path || item.name);
        }
      },
      onItemClick: (_item, index) => {
        this.selectedMentionIndex = index;
        this.selectMentionItem();
      },
      onItemHover: (_item, index) => {
        this.selectedMentionIndex = index;
      },
    });

    if (this.fixed) {
      this.positionFixed();
    }
  }

  private positionFixed(): void {
    const dropdownEl = this.dropdown.getElement();
    if (!dropdownEl) return;

    const inputRect = this.inputEl.getBoundingClientRect();
    dropdownEl.style.position = 'fixed';
    dropdownEl.style.bottom = `${window.innerHeight - inputRect.top + 4}px`;
    dropdownEl.style.left = `${inputRect.left}px`;
    dropdownEl.style.right = 'auto';
    dropdownEl.style.width = `${Math.max(inputRect.width, 280)}px`;
    dropdownEl.style.zIndex = '10001';
  }

  private selectMentionItem(): void {
    if (this.filteredMentionItems.length === 0) return;

    const selectedIndex = this.dropdown.getSelectedIndex();
    this.selectedMentionIndex = selectedIndex;
    const selectedItem = this.filteredMentionItems[selectedIndex];
    if (!selectedItem) return;

    const text = this.inputEl.value;
    const beforeAt = text.substring(0, this.mentionStartIndex);
    const cursorPos = this.inputEl.selectionStart || 0;
    const afterCursor = text.substring(cursorPos);

    if (selectedItem.type === 'mcp-server') {
      const replacement = `@${selectedItem.name} `;
      this.inputEl.value = beforeAt + replacement + afterCursor;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = beforeAt.length + replacement.length;

      this.callbacks.addMentionedMcpServer(selectedItem.name);
      this.callbacks.onMcpMentionChange?.(this.callbacks.getMentionedMcpServers());
    } else if (selectedItem.type === 'agent-folder') {
      // Don't modify input text - just show agents submenu
      this.activeAgentFilter = true;
      this.showMentionDropdown('Agents/');
      return;
    } else if (selectedItem.type === 'agent') {
      // Insert agent mention with (agent) suffix
      const replacement = `@${selectedItem.id} (agent) `;
      this.inputEl.value = beforeAt + replacement + afterCursor;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = beforeAt.length + replacement.length;

      // Notify callback with agent ID
      this.callbacks.onAgentMentionSelect?.(selectedItem.id);
    } else if (selectedItem.type === 'context-folder') {
      // Don't modify input text - just show files submenu
      this.activeContextFilter = {
        folderName: selectedItem.name,
        contextRoot: selectedItem.contextRoot,
      };
      this.showMentionDropdown(`${selectedItem.name}/`);
      return;
    } else if (selectedItem.type === 'context-file') {
      // Display friendly name, but store mapping for later transformation to absolute path
      const displayName = selectedItem.folderName
        ? `@${selectedItem.folderName}/${selectedItem.name}`
        : `@${selectedItem.name}`;

      if (selectedItem.absolutePath) {
        // Use context file callback if available, fallback to regular attach
        if (this.callbacks.onAttachContextFile) {
          this.callbacks.onAttachContextFile(displayName, selectedItem.absolutePath);
        } else {
          this.callbacks.onAttachFile(selectedItem.absolutePath);
        }
      }

      const replacement = `${displayName} `;
      this.inputEl.value = beforeAt + replacement + afterCursor;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = beforeAt.length + replacement.length;
    } else {
      const file = selectedItem.file;
      const rawPath = file?.path ?? selectedItem.path;
      const normalizedPath = this.callbacks.normalizePathForVault(rawPath);

      if (normalizedPath) {
        // Use full vault-relative path directly - no mapping needed
        this.callbacks.onAttachFile(normalizedPath);
      }

      // Insert full path so what user sees is what Claude gets
      const replacement = `@${normalizedPath ?? selectedItem.name} `;
      this.inputEl.value = beforeAt + replacement + afterCursor;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = beforeAt.length + replacement.length;
    }

    this.hide();
    this.inputEl.focus();
  }
}
