import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  registeredExecutionCapabilities,
  validateExecutionCapabilityRegistry,
} from '../packages/contracts/src/capability-registry';

const root = process.cwd();
const errors: string[] = [];
const capabilities = validateExecutionCapabilityRegistry(
  registeredExecutionCapabilities,
);
const packageScripts = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
) as { scripts?: Record<string, string> };

for (const capability of capabilities) {
  const workflowPath = join(root, capability.workflowPath);
  if (!existsSync(workflowPath)) {
    errors.push(
      `${capability.id}: missing workflow ${capability.workflowPath}`,
    );
    continue;
  }

  const workflow = readFileSync(workflowPath, 'utf8');
  if (!workflow.includes('workflow_dispatch:')) {
    errors.push(`${capability.id}: workflow is not dispatchable`);
  }
  if (
    !workflow.includes(`timeout-minutes: ${capability.maximumDurationMinutes}`)
  ) {
    errors.push(`${capability.id}: workflow timeout does not match registry`);
  }
  if (
    !workflow.includes(`codex exec --ephemeral --sandbox ${capability.sandbox}`)
  ) {
    errors.push(`${capability.id}: workflow sandbox does not match registry`);
  }
  if (
    !capability.allowsAdditionalWritableDirectories &&
    /\bcodex\s+exec\b[^\n]*--add-dir\b/.test(workflow)
  ) {
    errors.push(
      `${capability.id}: workflow adds unregistered writable directories`,
    );
  }
  if (
    capability.writePolicy === 'pull-request-only' &&
    (!workflow.includes('pull-requests: write') ||
      !workflow.includes('contents: write'))
  ) {
    errors.push(`${capability.id}: workflow lacks PR-only write permissions`);
  }
  for (const target of capability.validationTargets) {
    if (!packageScripts.scripts?.[target]?.trim()) {
      errors.push(`${capability.id}: missing validation target ${target}`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[capability-registry] ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `[capability-registry] verified: ${capabilities.map(({ id }) => id).join(', ')}`,
  );
}
