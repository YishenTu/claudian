import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const collabRoot = path.join(root, 'src/features/collab');

const legacyDirectories = [
  'access',
  'comments',
  'conflicts',
  'personal',
  'team',
  'tickets',
] as const;

const targetDirectories = [
  'detail',
  'handoff',
  'modals',
  'navigation',
  'shared',
  'sidebar',
] as const;

const scopedGuideDirectories = ['detail', 'modals', 'sidebar'] as const;

const legacyModulePaths = new Set([
  'src/features/collab/CollabDetailView',
  'src/features/collab/CollabDiffLanguage',
  'src/features/collab/CollabDiffRenderer',
  'src/features/collab/CollabFileKindCode',
  'src/features/collab/CollabPanel',
  'src/features/collab/CollabPreparedReviewCache',
  'src/features/collab/CollabShikiAdapter',
  'src/features/collab/CollabTransientSurfaceRegistry',
  'src/features/collab/CreateProjectModal',
  'src/features/collab/DeferredCollabSurfaceController',
  'src/features/collab/GitSetupPanel',
  'src/features/collab/JoinProjectModal',
  'src/features/collab/MarkdownDraftEditor',
  'src/features/collab/MarkdownTicketReferences',
  'src/features/collab/ProjectManagementModal',
  'src/features/collab/ReconnectProjectModal',
  'src/features/collab/ResponsiveCollabRouter',
  'src/features/collab/access/LanHostSection',
  'src/features/collab/comments/CollabCommentUI',
  'src/features/collab/conflicts/CollabConflictResolutionPanel',
  'src/features/collab/detail/ConflictDetailSession',
  'src/features/collab/detail/ReviewDetailSession',
  'src/features/collab/detail/ReviewDiffSession',
  'src/features/collab/detail/TicketDetailSession',
  'src/features/collab/personal/PersonalChangesPanel',
  'src/features/collab/team/TeamChangesPanel',
  'src/features/collab/team/TeamReviewLoader',
  'src/features/collab/tickets/TicketEditorPanel',
  'src/features/collab/tickets/TicketListPanel',
]);

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectTypeScriptFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

function extractModuleSpecifiers(source: string): string[] {
  const moduleSpecifierPattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bjest\.(?:doMock|mock|unmock)\s*\(\s*)['"]([^'"]+)['"]/g;

  return Array.from(source.matchAll(moduleSpecifierPattern), match => match[1]);
}

function normalizeRepositoryPath(filePath: string): string {
  return path.relative(root, filePath).replaceAll(path.sep, '/').replace(/\.ts$/, '');
}

function resolveRepositoryModulePath(importer: string, specifier: string): string | null {
  const normalizedSpecifier = specifier.replaceAll('\\', '/');
  const collabMarker = 'features/collab/';
  const collabMarkerIndex = normalizedSpecifier.indexOf(collabMarker);

  if (collabMarkerIndex >= 0) {
    return `src/${normalizedSpecifier.slice(collabMarkerIndex)}`.replace(/\.ts$/, '');
  }

  if (normalizedSpecifier.startsWith('.')) {
    return normalizeRepositoryPath(path.resolve(path.dirname(importer), normalizedSpecifier));
  }

  return null;
}

describe('Collab feature structure', () => {
  it('keeps production modules below a first-level surface boundary', () => {
    const directTypeScriptModules = readdirSync(collabRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
      .map(entry => entry.name)
      .sort();

    expect(directTypeScriptModules).toEqual([]);
  });

  it('removes the legacy mixed-axis directories', () => {
    const presentLegacyDirectories = legacyDirectories.filter(directory => (
      existsSync(path.join(collabRoot, directory))
    ));

    expect(presentLegacyDirectories).toEqual([]);
  });

  it('provides every required first-level surface boundary', () => {
    const missingTargetDirectories = targetDirectories.filter(directory => {
      const directoryPath = path.join(collabRoot, directory);

      return !existsSync(directoryPath) || !statSync(directoryPath).isDirectory();
    });

    expect(missingTargetDirectories).toEqual([]);
  });

  it('keeps detail sessions independent from the detail view implementation', () => {
    const sessionsRoot = path.join(collabRoot, 'detail/sessions');
    const forbiddenModulePath = 'src/features/collab/detail/CollabDetailView';
    const violations = existsSync(sessionsRoot)
      ? collectTypeScriptFiles(sessionsRoot).flatMap(filePath => (
          extractModuleSpecifiers(readFileSync(filePath, 'utf8'))
            .filter(specifier => (
              resolveRepositoryModulePath(filePath, specifier) === forbiddenModulePath
            ))
            .map(specifier => `${normalizeRepositoryPath(filePath)} -> ${specifier}`)
        ))
      : [];

    expect(violations).toEqual([]);
  });

  it('removes imports of every legacy Collab module path', () => {
    const violations = [path.join(root, 'src'), path.join(root, 'tests')]
      .flatMap(collectTypeScriptFiles)
      .flatMap(filePath => (
        extractModuleSpecifiers(readFileSync(filePath, 'utf8')).flatMap(specifier => {
          const modulePath = resolveRepositoryModulePath(filePath, specifier);

          return modulePath !== null && legacyModulePaths.has(modulePath)
            ? [`${normalizeRepositoryPath(filePath)} -> ${specifier}`]
            : [];
        })
      ));

    expect(violations).toEqual([]);
  });

  it('pairs each surface guide with an exact Claude import', () => {
    const violations = scopedGuideDirectories.flatMap(directory => {
      const directoryPath = path.join(collabRoot, directory);
      const agentsPath = path.join(directoryPath, 'AGENTS.md');
      const claudePath = path.join(directoryPath, 'CLAUDE.md');
      const directoryViolations: string[] = [];

      if (!existsSync(agentsPath)) {
        directoryViolations.push(`${directory}/AGENTS.md is missing`);
      }
      if (!existsSync(claudePath)) {
        directoryViolations.push(`${directory}/CLAUDE.md is missing`);
      } else if (readFileSync(claudePath, 'utf8') !== '@AGENTS.md\n') {
        directoryViolations.push(`${directory}/CLAUDE.md must contain only @AGENTS.md`);
      }

      return directoryViolations;
    });

    expect(violations).toEqual([]);
  });
});
