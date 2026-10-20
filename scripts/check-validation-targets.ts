import { inspectValidationTargets } from './validation-targets';

const { activePackages, errors } = inspectValidationTargets(process.cwd());

if (errors.length > 0) {
  for (const error of errors) console.error(`[validation] ${error}`);
  process.exitCode = 1;
} else {
  console.log(`[validation] active workspaces: ${activePackages.join(', ')}`);
}
