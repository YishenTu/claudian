import * as http from 'http';
import * as https from 'https';

import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type ClaudianPlugin from '../../../main';
import type { ClaudeDiscoveredModel } from '../types/models';

export interface ClaudeModelDiscoveryResult {
  diagnostics?: string;
  models: ClaudeDiscoveredModel[];
}

interface ApiModelEntry {
  id?: string;
  display_name?: string;
  created_at?: string;
  type?: string;
}

export class ClaudeModelDiscoveryService {
  constructor(private readonly plugin: ClaudianPlugin) {}

  async discoverModels(): Promise<ClaudeModelDiscoveryResult> {
    const envVars = getRuntimeEnvironmentVariables(
      this.plugin.settings as unknown as Record<string, unknown>,
      'claude',
    );

    const apiKey = envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      return {
        diagnostics: 'No ANTHROPIC_API_KEY found. Set it in Claudian environment variables or system environment.',
        models: [],
      };
    }

    const baseUrl = envVars.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

    try {
      const data = await this.fetchModels(baseUrl, apiKey);
      const models = normalizeApiResponse(data);
      return { models };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model discovery failed';
      return { diagnostics: message, models: [] };
    }
  }

  private fetchModels(baseUrl: string, apiKey: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL('/v1/models', baseUrl);
      const transport = url.protocol === 'https:' ? https : http;

      const req = transport.request(
        url,
        {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(body));
              } catch {
                reject(new Error(`Invalid JSON response from /v1/models`));
              }
            } else {
              reject(new Error(`API returned ${res.statusCode}: ${body.slice(0, 200)}`));
            }
          });
          res.on('error', reject);
        },
      );

      req.on('error', reject);
      req.setTimeout(15_000, () => {
        req.destroy(new Error('Request timed out'));
      });
      req.end();
    });
  }
}

function normalizeApiResponse(data: unknown): ClaudeDiscoveredModel[] {
  const entries = extractModelEntries(data);
  const models: ClaudeDiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    const displayName = typeof entry.display_name === 'string' && entry.display_name.trim()
      ? entry.display_name.trim()
      : id;
    const createdAt = typeof entry.created_at === 'string' ? entry.created_at : undefined;

    models.push({ id, displayName, createdAt });
  }

  return models;
}

function extractModelEntries(data: unknown): ApiModelEntry[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const record = data as Record<string, unknown>;
  const candidates = record.data ?? record.models ?? record.results;
  if (Array.isArray(candidates)) {
    return candidates.filter(
      (entry): entry is ApiModelEntry => entry !== null && typeof entry === 'object',
    );
  }

  return [];
}
