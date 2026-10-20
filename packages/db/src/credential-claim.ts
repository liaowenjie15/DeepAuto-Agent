import {
  AttemptStatus,
  type CredentialProvider,
  type PrismaClient,
} from './generated/prisma/client';

export type IssueCredentialClaimInput = {
  workspaceId: string;
  actorId: string;
  attemptId: string;
  provider: CredentialProvider;
  credentialReference: string;
  expiresAt: Date;
};

export type ConsumeCredentialClaimInput = {
  claimId: string;
  workspaceId: string;
  actorId: string;
  attemptId: string;
  now?: Date;
};

export async function issueCredentialClaim(
  prisma: PrismaClient,
  input: IssueCredentialClaimInput,
  now = new Date(),
) {
  if (input.expiresAt <= now) {
    throw new Error('Credential claim expiry must be in the future');
  }

  const attempt = await prisma.jobAttempt.findFirst({
    where: {
      id: input.attemptId,
      status: AttemptStatus.RUNNING,
      job: {
        invocation: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
        },
      },
    },
    select: { id: true, jobId: true },
  });

  if (!attempt) {
    throw new Error('Credential claim does not match an active Job attempt');
  }

  return prisma.$transaction(async (transaction) => {
    const claim = await transaction.credentialClaim.create({ data: input });
    await transaction.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        jobId: attempt.jobId,
        attemptId: attempt.id,
        action: 'credential.claim_issued',
        metadata: { claimId: claim.id, provider: input.provider },
      },
    });
    return claim;
  });
}

export async function consumeCredentialClaim(
  prisma: PrismaClient,
  input: ConsumeCredentialClaimInput,
): Promise<{ credentialReference: string } | null> {
  const now = input.now ?? new Date();

  return prisma.$transaction(async (transaction) => {
    const claim = await transaction.credentialClaim.findFirst({
      where: {
        id: input.claimId,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        attemptId: input.attemptId,
        expiresAt: { gt: now },
        usedAt: null,
      },
      select: { id: true, credentialReference: true },
    });

    if (!claim) return null;

    const consumed = await transaction.credentialClaim.updateMany({
      where: { id: claim.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });

    if (consumed.count !== 1) return null;

    await transaction.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        attemptId: input.attemptId,
        action: 'credential.claim_consumed',
        metadata: { claimId: claim.id },
      },
    });
    return { credentialReference: claim.credentialReference };
  });
}
