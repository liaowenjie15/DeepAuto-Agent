import { expect, test } from 'bun:test';
import {
  allowsExecutionCapabilitySource,
  createExecutionCapabilitySnapshot,
  resolveExecutionCapability,
  validateExecutionCapabilityRegistry,
} from './capability-registry';

test('registers the single supported PR-only execution capability', () => {
  const capability = resolveExecutionCapability();

  expect(capability.id).toBe('repository.change-pr.v1');
  expect(capability.writePolicy).toBe('pull-request-only');
  expect(allowsExecutionCapabilitySource(capability, 'github')).toBe(true);
  expect(allowsExecutionCapabilitySource(capability, 'feishu')).toBe(false);
});

test('rejects duplicate execution capability registrations', () => {
  const capability = resolveExecutionCapability();

  expect(() =>
    validateExecutionCapabilityRegistry([capability, capability]),
  ).toThrow('registered twice');
});

test('creates a deterministic policy snapshot for execution audit records', () => {
  const capability = resolveExecutionCapability();

  expect(createExecutionCapabilitySnapshot(capability)).toEqual(
    createExecutionCapabilitySnapshot(capability),
  );
});
