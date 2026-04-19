import type {
  TitleGenerationCallback,
  TitleGenerationService,
} from '../../../core/providers/types';
import { extractUserQuery } from '../../../utils/context';

const MAX_TITLE_LENGTH = 50;

export class OpencodeTitleGenerationService implements TitleGenerationService {
  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    const title = deriveTitle(userMessage);
    await callback(
      conversationId,
      title
        ? { success: true, title }
        : { success: false, error: 'Failed to derive title' },
    );
  }

  cancel(): void {}
}

function deriveTitle(userMessage: string): string | null {
  const query = extractUserQuery(userMessage)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!query) {
    return null;
  }

  const normalized = query.replace(/[.!?:;,]+$/, '');
  if (normalized.length <= MAX_TITLE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
}
