import type { ImageAttachment } from '@/core/types';

import { type DeepSeekReader,isRecord } from '../remote/DeepSeekRemoteClient';

export async function readDeepSeekImages(client: DeepSeekReader, sessionId: string, content: unknown): Promise<ImageAttachment[]> {
  if (!Array.isArray(content)) return [];
  const images: ImageAttachment[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image') continue;
    if (!isRecord(block.attachment) || typeof block.attachment.attachmentId !== 'string' || !block.attachment.attachmentId) {
      throw new Error('Malformed DeepSeek image reference.');
    }
    const response = await client.call('session/attachment', { request: { sessionId, attachmentId: block.attachment.attachmentId } });
    if (!isRecord(response) || !isRecord(response.attachment) || response.attachment.attachmentId !== block.attachment.attachmentId || typeof response.data !== 'string') throw new Error('Malformed DeepSeek image attachment.');
    const attachment = response.attachment;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(attachment.mediaType))) throw new Error('Unsupported DeepSeek image media type.');
    images.push({ id: block.attachment.attachmentId, name: typeof attachment.name === 'string' ? attachment.name : 'DeepSeek image',
      mediaType: attachment.mediaType as ImageAttachment['mediaType'], data: response.data,
      size: Buffer.byteLength(response.data, 'base64'), source: 'file',
    });
  }
  return images;
}

export async function materializeDeepSeekToolImages<T extends { type?: unknown; data?: unknown }>(client: DeepSeekReader, sessionId: string, event: T): Promise<T> {
  if (event.type !== 'tool/result' || !isRecord(event.data) || !isRecord(event.data.message)) return event;
  const images = await readDeepSeekImages(client, sessionId, event.data.message.content);
  if (!images.length) return event;
  return { ...event, data: { ...event.data, message: { ...event.data.message,
    content: [...(Array.isArray(event.data.message.content) ? event.data.message.content as unknown[] : []), ...images.map(image => ({ type: 'image', mediaType: image.mediaType, data: image.data, name: image.name }))],
  } } };
}
