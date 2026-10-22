import { z } from 'zod';

/**
 * POST /auth contract.
 *
 * IMPORTANT (verified against the live sandbox): on bad credentials
 * restful-booker answers **200** with `{ "reason": "Bad credentials" }` and no
 * token. A "successful status code" therefore proves nothing; the presence of a
 * non-empty token is the only reliable success signal. That is why this is a
 * discriminated union rather than a single object with an optional token.
 */
export const authTokenSchema = z.object({
  token: z.string().min(1),
});

export const authFailureSchema = z.object({
  reason: z.string().min(1),
});

export const authResponseSchema = z.union([authTokenSchema, authFailureSchema]);

export type AuthTokenResponse = z.infer<typeof authTokenSchema>;
export type AuthFailureResponse = z.infer<typeof authFailureSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;

export function hasToken(response: AuthResponse): response is AuthTokenResponse {
  return 'token' in response && typeof response.token === 'string' && response.token.length > 0;
}
