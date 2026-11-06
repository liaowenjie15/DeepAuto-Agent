import { createHash } from 'node:crypto';
import type { PrismaClient } from './generated/prisma/client';
import type { LarkTokenCipher } from './lark-token-cipher';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function claimLarkToolWrite(
  prisma: PrismaClient,
  input: {
    invocationId: string;
    workspaceId: string;
    actorId: string;
    appId: string;
    tenantKey: string;
    action: string;
    target: string;
    payload: unknown;
    cipher: LarkTokenCipher;
  },
): Promise<{ operationId: string } | null> {
  const payloadHash = digest(JSON.stringify(input.payload));
  const targetHash = digest(input.target);
  const operationKey = digest(input.invocationId);
  const snapshotEncrypted = input.cipher.encrypt(
    JSON.stringify({ action: input.action, target: input.target, payload: input.payload }),
    `lark-operation:${input.workspaceId}:${input.invocationId}`,
  );
  try {
    return await prisma.$transaction(async (transaction) => {
      const invocation = await transaction.invocation.findFirst({
        where: {
          id: input.invocationId,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          source: 'FEISHU',
          larkMessage: {
            appId: input.appId,
            tenantKey: input.tenantKey,
            processingState: 'CLAIMED',
          },
        },
        select: { id: true, larkMessage: { select: { senderOpenId: true } } },
      });
      if (!invocation?.larkMessage) return null;
      const member = await transaction.workspaceMember.findFirst({
        where: {
          id: input.actorId,
          workspaceId: input.workspaceId,
          larkOpenId: invocation.larkMessage.senderOpenId,
          active: true,
        },
        select: { id: true },
      });
      if (!member) return null;
      const operation = await transaction.larkToolOperation.create({
        data: {
          invocationId: invocation.id,
          operationKey,
          action: input.action,
          targetHash,
          payloadHash,
          snapshotEncrypted,
        },
        select: { id: true },
      });
      await transaction.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: 'lark.tool_write_claimed',
          metadata: {
            operationId: operation.id,
            action: input.action,
            targetHash,
            payloadHash,
            invocationId: input.invocationId,
          },
        },
      });
      return { operationId: operation.id };
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      return null;
    }
    throw error;
  }
}

export async function finishLarkToolWrite(
  prisma: PrismaClient,
  input: {
    operationId: string;
    workspaceId: string;
    actorId: string;
    succeeded: boolean;
    result?: unknown;
    cipher: LarkTokenCipher;
  },
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const operation = await transaction.larkToolOperation.findFirst({
      where: {
        id: input.operationId,
        state: 'CLAIMED',
        invocation: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
        },
      },
      select: { id: true, action: true, invocationId: true },
    });
    if (!operation) throw new Error('Lark tool operation claim was lost');
    await transaction.larkToolOperation.update({
      where: { id: operation.id },
      data: {
        state: input.succeeded ? 'SUCCEEDED' : 'UNKNOWN',
        finishedAt: new Date(),
        providerResultEncrypted: input.result === undefined
          ? undefined
          : input.cipher.encrypt(
              JSON.stringify(input.result),
              `lark-operation-result:${input.workspaceId}:${operation.invocationId}`,
            ),
      },
    });
    await transaction.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: input.succeeded
          ? 'lark.tool_write_succeeded'
          : 'lark.tool_write_unknown',
        metadata: { operationId: operation.id, action: operation.action },
      },
    });
  });
}
