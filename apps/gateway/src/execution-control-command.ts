import type { ExecutionControlResult } from '@deepauto/db';

export type GitHubExecutionControlCommand = {
  command: 'status' | 'cancel';
  scope: 'self' | 'workspace';
};

export function parseGitHubExecutionControlCommand(
  instruction: string,
): GitHubExecutionControlCommand | null {
  const normalized = instruction.trim().toLowerCase().replaceAll(/\s+/g, ' ');
  if (normalized === 'status' || normalized === '状态') {
    return { command: 'status', scope: 'self' };
  }
  if (normalized === 'cancel' || normalized === '取消') {
    return { command: 'cancel', scope: 'self' };
  }
  if (normalized === 'operator status' || normalized === '管理员 状态') {
    return { command: 'status', scope: 'workspace' };
  }
  if (normalized === 'operator cancel' || normalized === '管理员 取消') {
    return { command: 'cancel', scope: 'workspace' };
  }
  return null;
}

export function hasGitHubExecutionControlPrefix(instruction: string): boolean {
  return /^(?:status|cancel|operator|状态|取消|管理员)\b/i.test(
    instruction.trim(),
  );
}

export function executionControlReceipt(
  result: ExecutionControlResult,
): string {
  if (result.outcome === 'unauthorized') {
    return 'You are not authorized to control this conversation.';
  }
  if (result.outcome === 'no_active_job') {
    return 'There is no active DeepAuto task in this conversation.';
  }
  if (result.outcome === 'cancelled') {
    return 'The queued DeepAuto task was cancelled.';
  }
  if (result.outcome === 'requested') {
    return 'Cancellation was requested. The remote execution remains active until a terminal status is verified.';
  }
  if (result.outcome === 'already_requested') {
    return 'Cancellation is already pending for the active DeepAuto task.';
  }
  if (result.outcome === 'not_cancellable') {
    return 'The active DeepAuto task can no longer be cancelled.';
  }
  if (result.jobStatus === 'QUEUED') {
    return 'The DeepAuto task is queued.';
  }
  if (result.cancellationStatus === 'REQUESTED') {
    return 'The DeepAuto task is running and cancellation is awaiting dispatch.';
  }
  if (result.cancellationStatus === 'DISPATCHED') {
    return 'The DeepAuto task is running and cancellation is in progress.';
  }
  return 'The DeepAuto task is running.';
}
