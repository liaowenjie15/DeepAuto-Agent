import {
  allowsExecutionCapabilitySource,
  createExecutionCapabilitySnapshot,
  type InboundInvocation,
  resolveExecutionCapability,
  validateExecutionCapabilityRegistry,
} from '@deepauto/contracts';
import {
  type AuthorizedInvocation,
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

export type InboundInvocationAdmissionResult =
  | { accepted: true }
  | { accepted: false; reason: string; isFork?: boolean };

export type InboundInvocationAdmission = (
  invocation: InboundInvocation,
  authorized: AuthorizedInvocation,
) => Promise<InboundInvocationAdmissionResult>;

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
  admission?: InboundInvocationAdmission,
): Promise<DispatchResult> {
  if (!invocation) return { status: 'ignored' };

  const capability = resolveExecutionCapability();
  validateExecutionCapabilityRegistry([capability]);
  if (
    !allowsExecutionCapabilitySource(capability, invocation.source) ||
    !invocation.repositoryId
  ) {
    return { status: 'unauthorized' };
  }

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

  if (admission) {
    const decision = await admission(invocation, authorized);
    if (!decision.accepted) {
      const commentId = invocation.idempotencyKey.startsWith('github:comment:')
        ? invocation.idempotencyKey.slice('github:comment:'.length)
        : null;
      await prisma.auditEvent.create({
        data: {
          workspaceId: authorized.workspaceId,
          actorId: authorized.actorId,
          action: 'github.invocation_rejected',
          metadata: {
            reason: decision.reason,
            deliveryId: invocation.sourceEventId,
            commentId,
            repositoryId: invocation.repositoryId ?? null,
            anchor: invocation.anchor,
            isFork: decision.isFork ?? null,
          },
        },
      });
      return { status: 'unauthorized' };
    }
  }

  const created = await createOrGetInvocationJob(prisma, {
    ...authorized,
    receivedAt: new Date(authorized.receivedAt),
    idempotencyKey: invocation.idempotencyKey,
    repositoryId: invocation.repositoryId,
    capabilitySnapshot: createExecutionCapabilitySnapshot(capability),
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
