import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import { z } from 'zod';

const githubActionsOidcIssuer = 'https://token.actions.githubusercontent.com';
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${githubActionsOidcIssuer}/.well-known/jwks`),
);

const trustPolicySchema = z.object({
  audience: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  repositoryId: z.string().trim().min(1),
  workflowRef: z.string().trim().min(1),
  ref: z.string().trim().min(1),
  eventName: z.string().trim().min(1),
});

const claimsSchema = z.object({
  repository: z.string().trim().min(1),
  repository_id: z.union([
    z.string().trim().min(1),
    z.number().int().positive(),
  ]),
  workflow_ref: z.string().trim().min(1),
  ref: z.string().trim().min(1),
  event_name: z.string().trim().min(1),
  run_id: z.union([z.string().trim().min(1), z.number().int().positive()]),
  run_attempt: z.coerce.number().int().positive(),
});

export type GitHubActionsOidcTrustPolicy = z.input<typeof trustPolicySchema>;

export type GitHubActionsOidcClaims = z.infer<typeof claimsSchema>;

export type GitHubActionsOidcTokenVerifier = (
  token: string,
  policy: z.infer<typeof trustPolicySchema>,
) => Promise<JWTPayload>;

async function verifyWithGitHubJwks(
  token: string,
  policy: z.infer<typeof trustPolicySchema>,
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: githubActionsOidcIssuer,
    audience: policy.audience,
  });
  return payload;
}

export function assertGitHubActionsOidcClaims(
  payload: JWTPayload,
  policy: GitHubActionsOidcTrustPolicy,
): GitHubActionsOidcClaims {
  const parsedPolicy = trustPolicySchema.parse(policy);
  const claims = claimsSchema.parse(payload);

  if (claims.repository !== parsedPolicy.repository) {
    throw new Error('GitHub Actions OIDC repository claim is not trusted');
  }
  if (String(claims.repository_id) !== parsedPolicy.repositoryId) {
    throw new Error('GitHub Actions OIDC repository ID claim is not trusted');
  }
  if (claims.workflow_ref !== parsedPolicy.workflowRef) {
    throw new Error('GitHub Actions OIDC workflow claim is not trusted');
  }
  if (claims.ref !== parsedPolicy.ref) {
    throw new Error('GitHub Actions OIDC ref claim is not trusted');
  }
  if (claims.event_name !== parsedPolicy.eventName) {
    throw new Error('GitHub Actions OIDC event claim is not trusted');
  }

  return claims;
}

export async function verifyGitHubActionsOidcToken(
  token: string,
  policy: GitHubActionsOidcTrustPolicy,
  verifier: GitHubActionsOidcTokenVerifier = verifyWithGitHubJwks,
): Promise<GitHubActionsOidcClaims> {
  const parsedToken = z.string().trim().min(1).parse(token);
  const parsedPolicy = trustPolicySchema.parse(policy);
  const payload = await verifier(parsedToken, parsedPolicy);
  return assertGitHubActionsOidcClaims(payload, parsedPolicy);
}
