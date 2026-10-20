import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createGatewayApp } from './app';

const rawBody = JSON.stringify({ action: 'created' });
const signature = `sha256=${createHmac('sha256', 'secret')
  .update(rawBody)
  .digest('hex')}`;

test('rejects GitHub webhooks before parsing when the signature is invalid', async () => {
  const app = createGatewayApp({
    prisma: {} as never,
    githubWebhookSecret: 'secret',
    githubWorkspaceId: 'workspace-1',
    githubBotMention: '@deepauto',
  });
  const response = await app.request('/github/webhooks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=invalid',
    },
    body: rawBody,
  });

  expect(response.status).toBe(401);
});

test('ignores non-issue-comment events after a valid signature', async () => {
  const app = createGatewayApp({
    prisma: {} as never,
    githubWebhookSecret: 'secret',
    githubWorkspaceId: 'workspace-1',
    githubBotMention: '@deepauto',
  });
  const response = await app.request('/github/webhooks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
      'x-github-event': 'ping',
    },
    body: rawBody,
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ status: 'ignored' });
});
