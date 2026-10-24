import { expect, test } from 'bun:test';
import {
  hasGitHubExecutionControlPrefix,
  parseGitHubExecutionControlCommand,
} from './execution-control-command';

test('parses only explicit current-conversation execution control commands', () => {
  expect(parseGitHubExecutionControlCommand('status')).toEqual({
    command: 'status',
    scope: 'self',
  });
  expect(parseGitHubExecutionControlCommand('  OPERATOR   cancel ')).toEqual({
    command: 'cancel',
    scope: 'workspace',
  });
  expect(parseGitHubExecutionControlCommand('管理员 状态')).toEqual({
    command: 'status',
    scope: 'workspace',
  });
  expect(parseGitHubExecutionControlCommand('取消')).toEqual({
    command: 'cancel',
    scope: 'self',
  });
  expect(parseGitHubExecutionControlCommand('cancel job cm123')).toBeNull();
  expect(parseGitHubExecutionControlCommand('status for run 42')).toBeNull();
  expect(parseGitHubExecutionControlCommand('取消 execution-1')).toBeNull();
  expect(hasGitHubExecutionControlPrefix('cancel job cm123')).toBe(true);
  expect(hasGitHubExecutionControlPrefix('fix the cancellation race')).toBe(
    false,
  );
});
