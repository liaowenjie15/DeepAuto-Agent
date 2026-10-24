import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createGatewayApp } from '../../apps/gateway/src/app';
import type { PilotAdmissionConfiguration } from '../../apps/gateway/src/pilot-admission';
import {
  beginJobAttempt,
  createOrGetInvocationJob,
  createPrismaClient,
  getTestEnvironment,
  startExecution,
} from '../../packages/db/src';

const environment = getTestEnvironment();
const prisma = createPrismaClient(environment.databaseUrl);
const testPrefix = `gateway-integration-${crypto.randomUUID()}`;
const workspaceId = `${testPrefix}-workspace`;
const webhookSecret = 'test-webhook-secret';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    repository: { id: 42, full_name: 'deepauto/test-repository' },
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
  const member = await prisma.workspaceMember.create({
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
    pilotAdmission: {
      enabled: true,
      allowedWorkspaceIds: [workspaceId],
      allowedMemberIds: [member.id],
      allowedRepositoryIds: ['42'],
    },
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

test('pauses approved GitHub commands before creating a Job, then resumes without restarting', async () => {
  await prisma.workspace.create({ data: { id: workspaceId } });
  const member = await prisma.workspaceMember.create({
    data: { workspaceId, githubUserId: '8' },
  });
  await prisma.workspaceRepository.create({
    data: { workspaceId, providerRepositoryId: '42' },
  });
  let pilotAdmission: PilotAdmissionConfiguration = { enabled: false };
  const app = createGatewayApp({
    prisma,
    githubWebhookSecret: webhookSecret,
    githubWorkspaceId: workspaceId,
    githubBotMention: '@deepauto',
    pilotAdmission: () => pilotAdmission,
  });

  const response = await app.fetch(
    signedRequest(payload(), `${testPrefix}-paused-delivery`),
  );

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ status: 'paused' });
  expect(
    await prisma.job.count({ where: { invocation: { workspaceId } } }),
  ).toBe(0);
  expect(
    await prisma.auditEvent.findFirst({
      where: { workspaceId, action: 'pilot.invocation_paused' },
      select: { actorId: true, metadata: true },
    }),
  ).toEqual({
    actorId: expect.any(String),
    metadata: {
      reason: 'paused',
      source: 'github',
      sourceEventId: `${testPrefix}-paused-delivery`,
      repositoryId: '42',
    },
  });

  pilotAdmission = {
    enabled: true,
    allowedWorkspaceIds: [workspaceId],
    allowedMemberIds: [member.id],
    allowedRepositoryIds: ['42'],
  };
  const resumed = await app.fetch(
    signedRequest(payload(), `${testPrefix}-resumed-delivery`),
  );
  expect(resumed.status).toBe(202);
  expect(await resumed.json()).toMatchObject({
    status: 'accepted',
    created: true,
  });
  expect(
    await prisma.job.count({ where: { invocation: { workspaceId } } }),
  ).toBe(1);
});

test('rejects pilot commands outside the configured member scope and records the decision', async () => {
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
    pilotAdmission: {
      enabled: true,
      allowedWorkspaceIds: [workspaceId],
      allowedMemberIds: ['another-member'],
      allowedRepositoryIds: ['42'],
    },
  });

  const response = await app.fetch(
    signedRequest(payload(), `${testPrefix}-out-of-scope-delivery`),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ status: 'unauthorized' });
  expect(
    await prisma.job.count({ where: { invocation: { workspaceId } } }),
  ).toBe(0);
  expect(
    await prisma.auditEvent.findFirst({
      where: { workspaceId, action: 'pilot.invocation_rejected' },
      select: { metadata: true },
    }),
  ).toEqual({
    metadata: {
      reason: 'member_not_allowed',
      source: 'github',
      sourceEventId: `${testPrefix}-out-of-scope-delivery`,
      repositoryId: '42',
    },
  });
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

test('reports and cancels only the caller-owned queued conversation Job', async () => {
  await prisma.workspace.create({ data: { id: workspaceId } });
  const member = await prisma.workspaceMember.create({
    data: { workspaceId, githubUserId: '8' },
  });
  await prisma.workspaceRepository.create({
    data: { workspaceId, providerRepositoryId: '42' },
  });
  const created = await createOrGetInvocationJob(prisma, {
    source: 'github',
    workspaceId,
    actorId: member.id,
    conversationKey: 'github:42:7',
    anchor: 'pull-request',
    instruction: 'Fix the failing test',
    sourceEventId: `${testPrefix}-queued-source`,
    idempotencyKey: `${testPrefix}-queued-comment`,
    receivedAt: new Date(),
  });
  const receipts: string[] = [];
  const app = createGatewayApp({
    prisma,
    githubWebhookSecret: webhookSecret,
    githubWorkspaceId: workspaceId,
    githubBotMention: '@deepauto',
    githubCommentReceiptPublisher: {
      publish: async ({ body }) => {
        receipts.push(body);
      },
    },
  });

  const status = await app.fetch(
    signedRequest(
      payload({
        comment: { id: 100, body: '@deepauto status', user: { id: 8 } },
      }),
      `${testPrefix}-queued-status`,
    ),
  );
  expect(await status.json()).toEqual({
    status: 'controlled',
    receipt: 'The DeepAuto task is queued.',
  });

  const cancellation = await app.fetch(
    signedRequest(
      payload({
        comment: { id: 101, body: '@deepauto cancel', user: { id: 8 } },
      }),
      `${testPrefix}-queued-cancel`,
    ),
  );
  expect(await cancellation.json()).toEqual({
    status: 'controlled',
    receipt: 'The queued DeepAuto task was cancelled.',
  });
  expect(receipts).toEqual([
    'The DeepAuto task is queued.',
    'The queued DeepAuto task was cancelled.',
  ]);
  expect(
    await prisma.job.findUniqueOrThrow({
      where: { id: created.job.id },
      select: { status: true },
    }),
  ).toEqual({ status: 'CANCELLED' });
  expect(
    await prisma.auditEvent.count({
      where: { workspaceId, action: { startsWith: 'execution_control.' } },
    }),
  ).toBe(2);
});

test('allows an operator to request cancellation of another member current execution', async () => {
  await prisma.workspace.create({ data: { id: workspaceId } });
  const operator = await prisma.workspaceMember.create({
    data: { workspaceId, githubUserId: '8', role: 'OPERATOR' },
  });
  const owner = await prisma.workspaceMember.create({
    data: { workspaceId, githubUserId: '9' },
  });
  await prisma.workspaceRepository.create({
    data: { workspaceId, providerRepositoryId: '42' },
  });
  const created = await createOrGetInvocationJob(prisma, {
    source: 'github',
    workspaceId,
    actorId: owner.id,
    conversationKey: 'github:42:7',
    anchor: 'pull-request',
    instruction: 'Fix the failing test',
    sourceEventId: `${testPrefix}-running-source`,
    idempotencyKey: `${testPrefix}-running-comment`,
    receivedAt: new Date(),
  });
  const attempt = await beginJobAttempt(prisma, created.job.id);
  if (!attempt) throw new Error('Expected a running Job attempt');
  const execution = await startExecution(prisma, {
    attemptId: attempt.id,
    callbackExpiresAt: new Date(Date.now() + 60_000),
  });
  const app = createGatewayApp({
    prisma,
    githubWebhookSecret: webhookSecret,
    githubWorkspaceId: workspaceId,
    githubBotMention: '@deepauto',
  });

  const response = await app.fetch(
    signedRequest(
      payload({
        comment: {
          id: 102,
          body: '@deepauto operator cancel',
          user: { id: 8 },
        },
      }),
      `${testPrefix}-operator-cancel`,
    ),
  );

  expect(await response.json()).toEqual({
    status: 'controlled',
    receipt:
      'Cancellation was requested. The remote execution remains active until a terminal status is verified.',
  });
  expect(
    await prisma.executionCancellationRequest.findUniqueOrThrow({
      where: { executionId: execution.id },
      select: { requestedByActorId: true, status: true },
    }),
  ).toEqual({ requestedByActorId: operator.id, status: 'REQUESTED' });
  expect(
    await prisma.auditEvent.findFirstOrThrow({
      where: { workspaceId, action: 'execution_control.cancel' },
      select: { actorId: true, metadata: true },
    }),
  ).toEqual({
    actorId: operator.id,
    metadata: expect.objectContaining({
      outcome: 'requested',
      scope: 'workspace',
    }),
  });
  await prisma.outboxEvent.updateMany({
    where: { jobId: created.job.id, kind: 'EXECUTION_CANCEL' },
    data: { publishedAt: new Date() },
  });
});

test('does not let a member use the operator command or treat a bare Job ID as an instruction', async () => {
  await prisma.workspace.create({ data: { id: workspaceId } });
  const member = await prisma.workspaceMember.create({
    data: { workspaceId, githubUserId: '8' },
  });
  const owner = await prisma.workspaceMember.create({
    data: { workspaceId, githubUserId: '9' },
  });
  await prisma.workspaceRepository.create({
    data: { workspaceId, providerRepositoryId: '42' },
  });
  const created = await createOrGetInvocationJob(prisma, {
    source: 'github',
    workspaceId,
    actorId: owner.id,
    conversationKey: 'github:42:7',
    anchor: 'pull-request',
    instruction: 'Fix the failing test',
    sourceEventId: `${testPrefix}-member-source`,
    idempotencyKey: `${testPrefix}-member-comment`,
    receivedAt: new Date(),
  });
  const app = createGatewayApp({
    prisma,
    githubWebhookSecret: webhookSecret,
    githubWorkspaceId: workspaceId,
    githubBotMention: '@deepauto',
  });

  const operatorAttempt = await app.fetch(
    signedRequest(
      payload({
        comment: {
          id: 103,
          body: '@deepauto operator cancel',
          user: { id: 8 },
        },
      }),
      `${testPrefix}-member-operator-cancel`,
    ),
  );
  expect(await operatorAttempt.json()).toEqual({
    status: 'controlled',
    receipt: 'You are not authorized to control this conversation.',
  });

  const bareIdAttempt = await app.fetch(
    signedRequest(
      payload({
        comment: {
          id: 104,
          body: `@deepauto cancel ${created.job.id}`,
          user: { id: 8 },
        },
      }),
      `${testPrefix}-member-bare-id-cancel`,
    ),
  );
  expect(await bareIdAttempt.json()).toEqual({ status: 'ignored' });
  expect(
    await prisma.job.findUniqueOrThrow({
      where: { id: created.job.id },
      select: { status: true },
    }),
  ).toEqual({ status: 'QUEUED' });
  expect(
    await prisma.job.count({ where: { invocation: { workspaceId } } }),
  ).toBe(1);
  expect(
    await prisma.auditEvent.findFirstOrThrow({
      where: { workspaceId, action: 'execution_control.cancel' },
      select: { actorId: true, metadata: true },
    }),
  ).toEqual({
    actorId: member.id,
    metadata: expect.objectContaining({
      outcome: 'unauthorized',
      scope: 'workspace',
    }),
  });
});
