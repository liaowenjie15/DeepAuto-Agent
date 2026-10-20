import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createPrismaClient, getTestEnvironment } from '../../packages/db/src';
import { createGatewayApp } from '../../apps/gateway/src/app';

const environment = getTestEnvironment();
const prisma = createPrismaClient(environment.databaseUrl);
const testPrefix = `gateway-integration-${crypto.randomUUID()}`;
const workspaceId = `${testPrefix}-workspace`;
const webhookSecret = 'test-webhook-secret';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    repository: { id: 42 },
    issue: { number: 7, pull_request: {} },
    comment: {
      id: 99,
      body: '@deepauto fix the failing test',
      user: { id: 8 },
    },
    ...overrides,
  };
}

function signedRequest(body: unknown, deliveryId: string): Request {
  const rawBody = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex')}`;
  return new Request('http://localhost/github/webhooks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': deliveryId,
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': signature,
    },
    body: rawBody,
  });
}

beforeEach(async () => {
  await prisma.auditEvent.deleteMany({ where: { workspaceId } });
  await prisma.credentialClaim.deleteMany({ where: { workspaceId } });
  await prisma.job.deleteMany({ where: { invocation: { workspaceId } } });
  await prisma.invocation.deleteMany({ where: { workspaceId } });
  await prisma.workspaceRepository.deleteMany({ where: { workspaceId } });
  await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

test('accepts an authorized signed GitHub command and deduplicates its delivery', async () => {
  await prisma.workspace.create({ data: { id: workspaceId } });
  await prisma.workspaceMember.create({
    data: { workspaceId, githubUserId: '8' },
  });
  await prisma.workspaceRepository.create({
    data: { workspaceId, providerRepositoryId: '42' },
  });
  const app = createGatewayApp({
    prisma,
    githubWebhookSecret: webhookSecret,
    githubWorkspaceId: workspaceId,
    githubBotMention: '@deepauto',
  });

  const first = await app.fetch(
    signedRequest(payload(), `${testPrefix}-delivery`),
  );
  const duplicate = await app.fetch(
    signedRequest(payload(), `${testPrefix}-delivery`),
  );

  expect(first.status).toBe(202);
  expect(await first.json()).toMatchObject({
    status: 'accepted',
    created: true,
  });
  expect(duplicate.status).toBe(202);
  expect(await duplicate.json()).toMatchObject({
    status: 'accepted',
    created: false,
  });
  expect(await prisma.invocation.count({ where: { workspaceId } })).toBe(1);
  expect(
    await prisma.job.count({ where: { invocation: { workspaceId } } }),
  ).toBe(1);
});

test('rejects signed GitHub commands from an unmapped member', async () => {
  await prisma.workspace.create({ data: { id: workspaceId } });
  await prisma.workspaceRepository.create({
    data: { workspaceId, providerRepositoryId: '42' },
  });
  const app = createGatewayApp({
    prisma,
    githubWebhookSecret: webhookSecret,
    githubWorkspaceId: workspaceId,
    githubBotMention: '@deepauto',
  });

  const response = await app.fetch(
    signedRequest(payload(), `${testPrefix}-unmapped-delivery`),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ status: 'unauthorized' });
  expect(await prisma.invocation.count({ where: { workspaceId } })).toBe(0);
});
