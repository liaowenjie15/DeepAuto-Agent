import { expect, test } from 'bun:test';
import { toExecutionStatus } from './execute-job';

test('maps every normalized Harness terminal status to persistence status', () => {
  expect(toExecutionStatus('completed')).toBe('COMPLETED');
  expect(toExecutionStatus('failed')).toBe('FAILED');
  expect(toExecutionStatus('cancelled')).toBe('CANCELLED');
  expect(toExecutionStatus('timed_out')).toBe('TIMED_OUT');
});
