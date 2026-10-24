import type { InboundInvocation } from '@deepauto/contracts';
import {
  authorizeInboundInvocation,
  controlConversationExecution,
  createOrGetInvocationJob,
  type ExecutionControlResult,
  type PrismaClient,
} from '@deepauto/db';
import {
  evaluatePilotAdmission,
  type PilotAdmissionConfiguration,
} from './pilot-admission';

export type DispatchResult =
  | { status: 'ignored' }
  | { status: 'unauthorized' }
  | { status: 'paused' }
  | { status: 'accepted'; jobId: string; created: boolean };

export type PilotAdmissionProvider =
  | PilotAdmissionConfiguration
  | (() => PilotAdmissionConfiguration);

export type ExecutionControlDispatchResult =
  | { status: 'ignored' }
  | { status: 'unauthorized' }
  | { status: 'controlled'; result: ExecutionControlResult };

function resolvePilotAdmission(
  provider: PilotAdmissionProvider,
): PilotAdmissionConfiguration {
  return typeof provider === 'function' ? provider() : provider;
}

export async function dispatchInboundInvocation(
  prisma: PrismaClient,
  invocation: InboundInvocation | null,
  pilotAdmission?: PilotAdmissionProvider,
): Promise<DispatchResult> {
  if (!invocation) return { status: 'ignored' };

  const authorized = await authorizeInboundInvocation(prisma, invocation);
  if (!authorized) return { status: 'unauthorized' };

  if (pilotAdmission) {
    const decision = evaluatePilotAdmission(
      resolvePilotAdmission(pilotAdmission),
      invocation,
      authorized,
    );
    if (!decision.accepted) {
      await prisma.auditEvent.create({
        data: {
          workspaceId: authorized.workspaceId,
          actorId: authorized.actorId,
          action:
            decision.reason === 'paused'
              ? 'pilot.invocation_paused'
              : 'pilot.invocation_rejected',
          metadata: {
            reason: decision.reason,
            source: invocation.source,
            sourceEventId: invocation.sourceEventId,
            repositoryId: invocation.repositoryId ?? null,
          },
        },
      });
      return decision.reason === 'paused'
        ? { status: 'paused' }
        : { status: 'unauthorized' };
    }
  }

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

export async function dispatchExecutionControl(
  prisma: PrismaClient,
  invocation: InboundInvocation | null,
  command: { command: 'status' | 'cancel'; scope: 'self' | 'workspace' },
): Promise<ExecutionControlDispatchResult> {
  if (!invocation) return { status: 'ignored' };

  const authorized = await authorizeInboundInvocation(prisma, invocation);
  if (!authorized) return { status: 'unauthorized' };

  return {
    status: 'controlled',
    result: await controlConversationExecution(prisma, {
      workspaceId: authorized.workspaceId,
      actorId: authorized.actorId,
      memberRole: authorized.memberRole,
      conversationKey: authorized.conversationKey,
      command: command.command,
      scope: command.scope,
    }),
  };
}
