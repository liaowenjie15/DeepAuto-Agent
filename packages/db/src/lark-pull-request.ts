import {
  allowsExecutionCapabilitySource,
  createExecutionCapabilitySnapshot,
  resolveExecutionCapability,
} from '@deepauto/contracts';
import type { Prisma, PrismaClient } from './generated/prisma/client';

export async function createLarkPullRequestJob(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    actorId: string;
    invocationId: string;
    repositoryId: string;
    appId: string;
    tenantKey: string;
  },
): Promise<{ jobId: string; created: boolean } | null> {
  const capability = resolveExecutionCapability();
  if (!allowsExecutionCapabilitySource(capability, 'feishu')) return null;

  return prisma.$transaction(async (transaction) => {
    const invocation = await transaction.invocation.findFirst({
      where: {
        id: input.invocationId,
        source: 'FEISHU',
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        larkMessage: {
          appId: input.appId,
          tenantKey: input.tenantKey,
          processingState: 'CLAIMED',
        },
      },
      include: { job: true, larkMessage: true },
    });
    if (!invocation?.larkMessage) return null;
    if (invocation.job) {
      if (invocation.repositoryId !== input.repositoryId) return null;
      return { jobId: invocation.job.id, created: false };
    }

    const [member, repository] = await Promise.all([
      transaction.workspaceMember.findFirst({
        where: {
          id: input.actorId,
          workspaceId: input.workspaceId,
          active: true,
          larkOpenId: invocation.larkMessage.senderOpenId,
          githubUserId: { not: null },
          role: { in: ['OPERATOR', 'ADMIN'] },
        },
        select: { id: true },
      }),
      transaction.workspaceRepository.findFirst({
        where: {
          workspaceId: input.workspaceId,
          providerRepositoryId: input.repositoryId,
          enabled: true,
        },
        select: { id: true },
      }),
    ]);
    if (!member || !repository) return null;

    const snapshot = createExecutionCapabilitySnapshot(capability);
    const idempotencyKey = `feishu:message:${input.appId}:${input.tenantKey}:${invocation.larkMessage.messageId}`;
    const claimed = await transaction.invocation.updateMany({
      where: {
        id: invocation.id,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        repositoryId: null,
      },
      data: { repositoryId: input.repositoryId },
    });
    if (claimed.count !== 1) return null;

    const job = await transaction.job.create({
      data: {
        invocationId: invocation.id,
        conversationKey: invocation.conversationKey,
        idempotencyKey,
        capabilityId: snapshot.id,
        capabilityPolicyHash: snapshot.policyHash,
        capabilityPolicy: snapshot.policy as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    await transaction.outboxEvent.create({
      data: {
        jobId: job.id,
        kind: 'JOB_ENQUEUE',
        queueSequence: 0,
        dedupeKey: `job:${job.id}:enqueue`,
      },
    });
    await transaction.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        jobId: job.id,
        action: 'lark.pull_request_queued',
        metadata: {
          invocationId: invocation.id,
          repositoryId: input.repositoryId,
          capabilityId: snapshot.id,
        },
      },
    });
    return { jobId: job.id, created: true };
  });
}
