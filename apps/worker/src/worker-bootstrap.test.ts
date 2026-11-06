import { expect, test } from 'bun:test';
import { parseWorkerConfiguration } from './worker-bootstrap';

test('parses the single-repository worker configuration', () => {
  expect(
    parseWorkerConfiguration({
      DATABASE_URL: 'postgresql://deepauto:password@localhost:5432/deepauto',
      REDIS_URL: 'redis://localhost:6379',
      GITHUB_APP_ID: '1',
      GITHUB_APP_INSTALLATION_ID: '2',
      GITHUB_APP_PRIVATE_KEY:
        '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----',
      DEEPAUTO_GITHUB_REPOSITORY: 'liaowenjie15/DeepAuto-Agent',
      DEEPAUTO_GITHUB_REPOSITORY_ID: '1423344804',
    }),
  ).toMatchObject({
    DEEPAUTO_EXECUTION_QUEUE_NAME: 'deepauto-execute',
    DEEPAUTO_EXECUTION_CONTROL_QUEUE_NAME: 'deepauto-execution-control',
    GITHUB_APP_PRIVATE_KEY:
      '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
  });
});

test('rejects incomplete worker configuration without exposing values', () => {
  expect(() => parseWorkerConfiguration({})).toThrow(
    'Worker configuration is invalid',
  );
});
