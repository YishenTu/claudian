import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ProviderExecutionRequest } from '@/core/execution';
import { appendSelectionContexts, appendSessionReferences } from '@/core/prompt/promptContext';
import type { ImageAttachment } from '@/core/types';
import type { UserInput } from '@/providers/codex/runtime/codexAppServerTypes';

export interface CodexInputBundle {
  readonly input: UserInput[];
}

/**
 * Builds native turn input and owns its temporary image files until submission.
 * Unsubmitted images are released when the run ends or the session is disposed;
 * submitted images belong to the thread scope until the native turn settles.
 */
export class CodexInputBundles {
  #cleanupByBundle = new Map<CodexInputBundle, () => void>();

  constructor(private readonly mapRequiredHostPath: (hostPath: string) => string) {}

  create(request: ProviderExecutionRequest, promptOverride?: string): CodexInputBundle {
    const { input, cleanup } = this.#build(request, promptOverride);
    const bundle: CodexInputBundle = { input };
    this.#cleanupByBundle.set(bundle, cleanup);
    return bundle;
  }

  /**
   * Transfers cleanup to the native submission owner, which releases the images
   * once the server has consumed or rejected them; the session stops tracking them.
   */
  handOff(bundle: CodexInputBundle): () => void {
    const cleanup = this.#cleanupByBundle.get(bundle) ?? (() => undefined);
    this.#cleanupByBundle.delete(bundle);
    return cleanup;
  }

  releaseAll(): void {
    for (const cleanup of this.#cleanupByBundle.values()) cleanup();
    this.#cleanupByBundle.clear();
  }

  #build(
    request: ProviderExecutionRequest,
    promptOverride?: string,
  ): { input: UserInput[]; cleanup: () => void } {
    const input: UserInput[] = [];
    let tempDirectory: string | null = null;
    const cleanup = () => {
      if (!tempDirectory) return;
      try {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      } catch {
        // Temporary image cleanup is best-effort.
      }
      tempDirectory = null;
    };

    try {
      const images = request.input
        .filter(block => block.type === 'image')
        .map(block => block.image);
      if (images.length > 0) {
        tempDirectory = fs.mkdtempSync(
          path.join(os.tmpdir(), 'claudian-codex-images-'),
        );
        images.forEach((image, index) => {
          if (!image.mediaType.startsWith('image/')) return;
          const filePath = path.join(
            tempDirectory!,
            `${index + 1}-${toAttachmentFilename(image, index)}`,
          );
          fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
          input.push({
            type: 'localImage',
            path: this.mapRequiredHostPath(filePath),
          });
        });
      }

      const prompt = promptOverride ?? appendSelectionContexts(appendSessionReferences(
        request.input
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n\n'),
        request.context?.sessionReferences,
        hostPath => this.mapRequiredHostPath(hostPath),
      ), request.context);
      if (prompt) {
        input.push({ type: 'text', text: prompt, text_elements: [] });
      }
      return { input, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}

function toAttachmentFilename(
  attachment: ImageAttachment,
  index: number,
): string {
  const sourceName = attachment.name.trim();
  const base = sourceName.replace(/[^A-Za-z0-9._-]/g, '_')
    || `image-${index + 1}`;
  if (base.includes('.')) return base;
  const subtype = attachment.mediaType.split('/')[1] ?? 'img';
  return `${base}.${subtype === 'jpeg' ? 'jpg' : subtype}`;
}
