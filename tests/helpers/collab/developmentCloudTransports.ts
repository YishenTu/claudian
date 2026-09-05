import { WebSocket } from 'ws';

import {
  CloudAuthorityAdapter,
  CloudProjectEventClient,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import type { CollabAuthorityGitNetwork } from '@/app/collab/remote-authority/CollabAuthoritySession';
import { NodeCloudAuthorityArtifactTransport } from '@/app/collab/remote-authority/NodeCloudAuthorityArtifactTransport';
import { NodeCloudAuthorityHttpTransport } from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';

/** Explicit test ingress assertions; never part of a persisted Cloud binding or production adapter. */
export function createDevelopmentCloudAuthorityAdapter(vaultRoot: string, actor: string): CloudAuthorityAdapter {
  const http = new NodeCloudAuthorityHttpTransport();
  const artifacts = new NodeCloudAuthorityArtifactTransport();
  const headers = (input: Readonly<Record<string, string>>) => ({
    ...input,
    'x-claudian-development-actor': actor,
  });
  return new CloudAuthorityAdapter(vaultRoot, {
    artifacts: {
      download: input => artifacts.download({ ...input, headers: headers(input.headers) }),
      upload: input => artifacts.upload({ ...input, headers: headers(input.headers) }),
    },
    createEventClient: (input, onInvalidation) => new CloudProjectEventClient(input, onInvalidation, {
      createSocket: request => {
        const socket = new WebSocket(request.url, {
          headers: headers(request.headers),
          perMessageDeflate: false,
        });
        return {
          close: (code, reason) => socket.close(code, reason),
          onClose: listener => { socket.on('close', listener); },
          onError: listener => { socket.on('error', listener); },
          onMessage: listener => { socket.on('message', data => listener(data.toString())); },
          onOpen: listener => { socket.on('open', listener); },
        };
      },
    }),
    request: input => http.request({ ...input, headers: headers(input.headers) }),
  });
}

export function developmentCloudGitNetwork(
  network: CollabAuthorityGitNetwork,
  actor: string,
): CollabAuthorityGitNetwork {
  return {
    ...network,
    headers: [...network.headers, {
      name: 'X-Claudian-Development-Actor',
      sensitive: false,
      value: actor,
    }],
  };
}
