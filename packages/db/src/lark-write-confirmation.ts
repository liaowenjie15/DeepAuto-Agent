import { createHash } from 'node:crypto';
import type { PrismaClient } from './generated/prisma/client';

type LarkWriteConfirmationClient = Pick<
  PrismaClient,
  'invocation' | 'workspaceMember' | 'larkWriteConfirmation' | 'auditEvent'
>;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

type LarkWriteConfirmationInput = {
  invocationId: string;
  workspaceId: string;
  actorId: string;
  conversationKey: string;
  appId: string;
  tenantKey: string;
  action: string;
  target: string;
  payload: unknown;
};

async function hasAuthorizedLarkWriteInvocation(
  prisma: LarkWriteConfirmationClient,
  input: LarkWriteConfirmationInput,
): Promise<boolean> {
  const invocation = await prisma.invocation.findFirst({
    where: {
      id: input.invocationId,
      source: 'FEISHU',
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      conversationKey: input.conversationKey,
      larkMessage: {
        appId: input.appId,
        tenantKey: input.tenantKey,
        processingState: 'CLAIMED',
      },
    },
    select: { id: true },
  });
  if (!invocation) return false;
  const member = await prisma.workspaceMember.findFirst({
    where: {
      id: input.actorId,
      workspaceId: input.workspaceId,
      active: true,
      role: { in: ['OPERATOR', 'ADMIN'] },
    },
    select: { id: true },
  });
  return Boolean(member);
}

function confirmationKey(input: LarkWriteConfirmationInput) {
  return {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    appId: input.appId,
    tenantKey: input.tenantKey,
    conversationKey: input.conversationKey,
    action: input.action,
    targetHash: digest(input.target),
    payloadHash: digest(JSON.stringify(input.payload)),
  };
}

export async function requestLarkWriteConfirmation(
  prisma: PrismaClient,
  input: LarkWriteConfirmationInput,
): Promise<{ expiresAt: Date } | null> {
  const key = confirmationKey(input);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000);
  try {
    return await prisma.$transaction(async (transaction) => {
      if (!(await hasAuthorizedLarkWriteInvocation(transaction, input)))
        return null;

      await transaction.larkWriteConfirmation.updateMany({
        where: {
          ...key,
          consumedAt: null,
          invalidatedAt: null,
          expiresAt: { lte: now },
        },
        data: { invalidatedAt: now },
      });
      const existing = await transaction.larkWriteConfirmation.findFirst({
        where: {
          ...key,
          consumedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: now },
        },
        select: { expiresAt: true },
      });
      if (existing) return existing;

      const confirmation = await transaction.larkWriteConfirmation.create({
        data: { ...key, expiresAt },
        select: { id: true },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: 'lark.write_confirmation_requested',
          metadata: {
            confirmationId: confirmation.id,
            action: input.action,
            targetHash: key.targetHash,
            payloadHash: key.payloadHash,
          },
        },
      });
      return { expiresAt };
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    return prisma.$transaction(async (transaction) => {
      if (!(await hasAuthorizedLarkWriteInvocation(transaction, input)))
        return null;
      return transaction.larkWriteConfirmation.findFirst({
        where: {
          ...key,
          consumedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: now },
        },
        select: { expiresAt: true },
      });
    });
  }
}

export async function consumeLarkWriteConfirmation(
  prisma: PrismaClient,
  input: LarkWriteConfirmationInput,
): Promise<boolean> {
  const key = confirmationKey(input);
  const now = new Date();
  return prisma.$transaction(async (transaction) => {
    if (!(await hasAuthorizedLarkWriteInvocation(transaction, input)))
      return false;
    const confirmation = await transaction.larkWriteConfirmation.findFirst({
      where: {
        ...key,
        consumedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (!confirmation) return false;
    const consumed = await transaction.larkWriteConfirmation.updateMany({
      where: {
        id: confirmation.id,
        consumedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) return false;
    await transaction.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: 'lark.write_confirmation_consumed',
        metadata: {
          confirmationId: confirmation.id,
          action: input.action,
          targetHash: key.targetHash,
          payloadHash: key.payloadHash,
        },
      },
    });
    return true;
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
