import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

const issuer = 'deepauto-gateway';
const audience = 'deepauto-codex-proxy';

const issueInputSchema = z.object({
  executionId: z.string().trim().min(1),
  expiresAt: z.date(),
  secret: z.string().min(32),
  now: z.date().optional(),
});

const claimsSchema = z.object({
  execution_id: z.string().trim().min(1),
});

export type ExecutionProxyTokenClaims = z.infer<typeof claimsSchema>;

function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function issueExecutionProxyToken(input: {
  executionId: string;
  expiresAt: Date;
  secret: string;
  now?: Date;
}): Promise<string> {
  const parsed = issueInputSchema.parse(input);
  const now = parsed.now ?? new Date();
  if (parsed.expiresAt <= now) {
    throw new Error('Execution proxy token expiry must be in the future');
  }

  return new SignJWT({ execution_id: parsed.executionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(parsed.executionId)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(parsed.expiresAt.getTime() / 1000))
    .sign(signingKey(parsed.secret));
}

export async function verifyExecutionProxyToken(
  token: string,
  secret: string,
  now?: Date,
): Promise<ExecutionProxyTokenClaims> {
  const parsedToken = z.string().trim().min(1).parse(token);
  const parsedSecret = z.string().min(32).parse(secret);
  const { payload } = await jwtVerify(parsedToken, signingKey(parsedSecret), {
    issuer,
    audience,
    currentDate: now,
  });
  const claims = claimsSchema.parse(payload);
  if (payload.sub !== claims.execution_id) {
    throw new Error('Execution proxy token subject does not match execution');
  }
  return claims;
}
