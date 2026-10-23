import { z } from 'zod';

/**
 * Best-effort contract for JSON error bodies.
 *
 * The public sandbox answers some failures with `text/plain` ("Not Found",
 * "Forbidden", "Bad Request"), while other hosts return JSON. Callers must
 * therefore handle both and must NOT require a JSON body to decide that a
 * request failed - the status code is authoritative.
 */
export const jsonErrorBodySchema = z
  .object({
    reason: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .catchall(z.unknown());

export type JsonErrorBody = z.infer<typeof jsonErrorBodySchema>;
