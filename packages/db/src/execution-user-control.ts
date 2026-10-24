import {
  type ExecutionCancellationRequestStatus,
  type ExecutionStatus,
  JobStatus,
  MemberRole,
  type PrismaClient,
} from './generated/prisma/client';
import { requestJobCancellation } from './job-lifecycle';

export type ExecutionControlCommand = 'status' | 'cancel';
export type ExecutionControlScope = 'self' | 'workspace';

export type ExecutionControlInput = {
  workspaceId: string;
  actorId: string;
  memberRole: MemberRole;
  conversationKey: string;
  command: ExecutionControlCommand;
  scope: ExecutionControlScope;
  now?: Date;
};

export type ExecutionControlResult = {
  outcome:
    | 'active'
    | 'cancelled'
    | 'requested'
    | 'already_requested'
    | 'not_cancellable'
    | 'no_active_job'
    | 'unauthorized';
  jobStatus?: JobStatus;
  executionStatus?: ExecutionStatus;
  cancellationStatus?: ExecutionCancellationRequestStatus;
};

function isWorkspaceControlAllowed(role: MemberRole): boolean {
  return role === MemberRole.OPERATOR || role === MemberRole.ADMIN;
}

export async function controlConversationExecution(
  prisma: PrismaClient,
  input: ExecutionControlInput,
): Promise<ExecutionControlResult> {
  if (
    input.scope === 'workspace' &&
    !isWorkspaceControlAllowed(input.memberRole)
  ) {
    await prisma.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: `execution_control.${input.command}`,
        metadata: {
          outcome: 'unauthorized',
          scope: input.scope,
          conversationKey: input.conversationKey,
        },
      },
    });
    return { outcome: 'unauthorized' };
  }

  const job = await prisma.job.findFirst({
    where: {
      conversationKey: input.conversationKey,
      status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
      invocation: {
        workspaceId: input.workspaceId,
        ...(input.scope === 'self' ? { actorId: input.actorId } : {}),
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      status: true,
      currentAttemptNumber: true,
      attempts: {
        orderBy: { number: 'desc' },
        take: 1,
        select: {
          id: true,
          execution: {
            select: {
              status: true,
              cancellationRequest: { select: { status: true } },
            },
          },
        },
      },
    },
  });

  if (!job) {
    await prisma.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: `execution_control.${input.command}`,
        metadata: {
          outcome: 'no_active_job',
          scope: input.scope,
          conversationKey: input.conversationKey,
        },
      },
    });
    return { outcome: 'no_active_job' };
  }

  const attempt = job.attempts[0];
  const current = {
    jobStatus: job.status,
    executionStatus: attempt?.execution?.status,
    cancellationStatus: attempt?.execution?.cancellationRequest?.status,
  };

  if (input.command === 'status') {
    await prisma.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        jobId: job.id,
        attemptId: attempt?.id,
        action: 'execution_control.status',
        metadata: {
          outcome: 'active',
          scope: input.scope,
          conversationKey: input.conversationKey,
          jobStatus: job.status,
          executionStatus: current.executionStatus ?? null,
          cancellationStatus: current.cancellationStatus ?? null,
        },
      },
    });
    return { outcome: 'active', ...current };
  }

  const cancellation = await requestJobCancellation(prisma, {
    jobId: job.id,
    requestedByActorId: input.actorId,
    now: input.now,
  });
  const outcome = cancellation.state;
  await prisma.auditEvent.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      jobId: job.id,
      attemptId: attempt?.id,
      action: 'execution_control.cancel',
      metadata: {
        outcome,
        scope: input.scope,
        conversationKey: input.conversationKey,
        jobStatus: job.status,
        executionStatus: current.executionStatus ?? null,
      },
    },
  });
  return { outcome, ...current };
}
