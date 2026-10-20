import type { InboundInvocation } from '@deepauto/contracts';
import {
  authorizeInboundInvocation,
  createOrGetInvocationJob,
  type PrismaClient,
} from '@deepauto/db';

export type DispatchResult =
  | { status: 'ignored' }
  | { status: 'unauthorized' }
  | { status: 'accepted'; jobId: string; created: boolean };

export async function dispatchInboundInvocation(
  prisma: PrismaClient,
  invocation: InboundInvocation | null,
): Promise<DispatchResult> {
  if (!invocation) return { status: 'ignored' };

  const authorized = await authorizeInboundInvocation(prisma, invocation);
  if (!authorized) return { status: 'unauthorized' };

  const created = await createOrGetInvocationJob(prisma, {
    ...authorized,
    receivedAt: new Date(authorized.receivedAt),
    idempotencyKey: invocation.idempotencyKey,
  });
  return {
    status: 'accepted',
    jobId: created.job.id,
    created: created.created,
  };
}
