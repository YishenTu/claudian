import { createServer, type Server } from 'node:http';

import { COLLAB_LIMITS } from '@claudian-collab/protocol';

import { CloudPersonalRefReader } from '@/app/collab/remote-authority/CloudPersonalRefReader';

const servers: Server[] = [];
const VALID_ADVERTISEMENT = Buffer.from(
  '001e# service=git-upload-pack\n'
  + '0000'
  + '003caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa HEAD\0multi_ack\n'
  + '004dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/members/member-alpha\n'
  + '003dcccccccccccccccccccccccccccccccccccccccc refs/heads/main\n'
  + '0000',
  'utf8',
);

function packet(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([
    Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'),
    body,
  ]);
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address missing');
  return `http://127.0.0.1:${address.port}/operator-prefix`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close(error => {
      if (error) reject(error);
      else resolve();
    }));
  }));
});

describe('CloudPersonalRefReader', () => {
  it('reads one exact personal ref from a bounded v0 upload-pack advertisement', async () => {
    let seenHeaders: Readonly<Record<string, string | readonly string[] | undefined>> | null = null;
    let seenUrl: string | undefined;
    const origin = await listen(createServer((request, response) => {
      seenHeaders = request.headers;
      seenUrl = request.url;
      response.setHeader('content-type', 'application/x-git-upload-pack-advertisement');
      response.end(VALID_ADVERTISEMENT);
    }));

    await expect(new CloudPersonalRefReader().read({
      personalRef: 'refs/heads/members/member-alpha',
      projectId: 'project-alpha',
      serverUrl: origin,
    })).resolves.toBe('b'.repeat(40));

    expect(seenUrl).toBe(
      '/operator-prefix/v5/projects/project-alpha/repository.git/info/refs?service=git-upload-pack',
    );
    expect(seenHeaders).toMatchObject({
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    });
    expect(seenHeaders?.['git-protocol']).toBeUndefined();
  });

  it('accepts a legal peeled annotated tag without treating it as a personal ref', async () => {
    const advertisement = Buffer.concat([
      packet('# service=git-upload-pack\n'),
      Buffer.from('0000', 'ascii'),
      packet(`${'a'.repeat(40)} HEAD\0multi_ack\n`),
      packet(`${'b'.repeat(40)} refs/heads/members/member-alpha\n`),
      packet(`${'c'.repeat(40)} refs/tags/v1\n`),
      packet(`${'d'.repeat(40)} refs/tags/v1^{}\n`),
      Buffer.from('0000', 'ascii'),
    ]);
    const origin = await listen(createServer((_request, response) => {
      response.setHeader('content-type', 'application/x-git-upload-pack-advertisement');
      response.end(advertisement);
    }));

    await expect(new CloudPersonalRefReader().read({
      personalRef: 'refs/heads/members/member-alpha',
      projectId: 'project-alpha',
      serverUrl: origin,
    })).resolves.toBe('b'.repeat(40));
  });

  it.each([
    {
      body: VALID_ADVERTISEMENT,
      contentType: 'application/octet-stream',
      name: 'wrong MIME',
      status: 200,
    },
    {
      body: VALID_ADVERTISEMENT,
      contentType: 'application/x-git-upload-pack-advertisement',
      name: 'redirect',
      status: 307,
    },
    {
      body: Buffer.from(VALID_ADVERTISEMENT.toString('utf8').replace(
        '001e# service=git-upload-pack\n',
        '001e# service=git-receive-pack\n',
      )),
      contentType: 'application/x-git-upload-pack-advertisement',
      name: 'wrong service',
      status: 200,
    },
    {
      body: Buffer.from(VALID_ADVERTISEMENT.subarray(0, -2)),
      contentType: 'application/x-git-upload-pack-advertisement',
      name: 'truncated packet',
      status: 200,
    },
    {
      body: Buffer.from(VALID_ADVERTISEMENT.toString('utf8').replace(
        '0000',
        '0000000dversion 2\n',
      )),
      contentType: 'application/x-git-upload-pack-advertisement',
      name: 'protocol v2',
      status: 200,
    },
    {
      body: Buffer.from(VALID_ADVERTISEMENT.toString('utf8').replace(
        '003dcccccccccccccccccccccccccccccccccccccccc refs/heads/main\n',
        '004dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/members/member-alpha\n',
      )),
      contentType: 'application/x-git-upload-pack-advertisement',
      name: 'duplicate personal ref',
      status: 200,
    },
    {
      body: Buffer.from(VALID_ADVERTISEMENT.toString('utf8').replace(
        'refs/heads/members/member-alpha',
        'refs/heads/members/member-bravo',
      )),
      contentType: 'application/x-git-upload-pack-advertisement',
      name: 'missing personal ref',
      status: 200,
    },
    {
      body: Buffer.from(VALID_ADVERTISEMENT.toString('utf8').replace(
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/members/member-alpha',
        'gbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/members/member-alpha',
      )),
      contentType: 'application/x-git-upload-pack-advertisement',
      name: 'invalid object id',
      status: 200,
    },
    {
      body: Buffer.from(VALID_ADVERTISEMENT.toString('utf8').replace('004d', 'zzzz')),
      contentType: 'application/x-git-upload-pack-advertisement',
      name: 'invalid packet length',
      status: 200,
    },
  ])('fails closed for $name', async ({ body, contentType, status }) => {
    const origin = await listen(createServer((_request, response) => {
      response.statusCode = status;
      response.setHeader('content-type', contentType);
      response.end(body);
    }));

    await expect(new CloudPersonalRefReader().read({
      personalRef: 'refs/heads/members/member-alpha',
      projectId: 'project-alpha',
      serverUrl: origin,
    })).rejects.toMatchObject({ code: 'protocol-payload-invalid' });
  });

  it('tears down a stalled advertisement at the deadline', async () => {
    const origin = await listen(createServer(() => undefined));

    await expect(new CloudPersonalRefReader(20).read({
      personalRef: 'refs/heads/members/member-alpha',
      projectId: 'project-alpha',
      serverUrl: origin,
    })).rejects.toMatchObject({ code: 'operation-timeout' });
  });

  it('rejects a response whose declared size exceeds the shared JSON bound', async () => {
    const origin = await listen(createServer((_request, response) => {
      response.setHeader('content-length', String(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes + 1));
      response.setHeader('content-type', 'application/x-git-upload-pack-advertisement');
      response.end('0');
    }));

    await expect(new CloudPersonalRefReader().read({
      personalRef: 'refs/heads/members/member-alpha',
      projectId: 'project-alpha',
      serverUrl: origin,
    })).rejects.toMatchObject({ code: 'protocol-payload-invalid' });
  });

  it('stops an undeclared streamed response at the shared JSON bound', async () => {
    const origin = await listen(createServer((_request, response) => {
      response.setHeader('content-type', 'application/x-git-upload-pack-advertisement');
      response.write(Buffer.alloc(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes, 0x61));
      response.end('a');
    }));

    await expect(new CloudPersonalRefReader().read({
      personalRef: 'refs/heads/members/member-alpha',
      projectId: 'project-alpha',
      serverUrl: origin,
    })).rejects.toMatchObject({ code: 'protocol-payload-invalid' });
  });
});
