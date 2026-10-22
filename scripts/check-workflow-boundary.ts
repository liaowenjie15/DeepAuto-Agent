import { inspectWorkflowBoundary } from './workflow-boundary';

const errors = inspectWorkflowBoundary(process.cwd());

if (errors.length > 0) {
  for (const error of errors) console.error(`[workflow-boundary] ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    '[workflow-boundary] execution workflow respects control-plane boundaries',
  );
}
