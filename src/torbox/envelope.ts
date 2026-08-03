import { z } from 'zod';
import { logger } from '../logger.js';

export class TorboxApiError extends Error {
  constructor(
    message: string,
    public readonly context: string,
  ) {
    super(message);
    this.name = 'TorboxApiError';
  }
}

const successFlagSchema = z.object({ success: z.boolean() });

/**
 * TorBox wraps every response as {success, ..., data}. On auth errors it
 * returns {"success":false,...,"data":null} — which is shaped just enough
 * like "an empty library" to slip through unnoticed if `success` isn't
 * checked FIRST, before `data` is ever looked at. Always logs the raw body
 * on any failure (spec §5.1): both an explicit success:false, and a
 * success:true body whose `data` doesn't match what we expected.
 */
export function parseEnvelope<T>(rawBody: unknown, dataSchema: z.ZodType<T>, context: string): T {
  const flagCheck = successFlagSchema.safeParse(rawBody);
  if (!flagCheck.success || !flagCheck.data.success) {
    logger.error(
      { context, rawBody },
      'TorBox API returned success:false (or an unrecognisable envelope)',
    );
    throw new TorboxApiError(`TorBox API call failed: ${context}`, context);
  }

  const dataCheck = z.object({ data: dataSchema }).safeParse(rawBody);
  if (!dataCheck.success) {
    logger.error(
      { context, rawBody, issues: dataCheck.error.issues },
      'TorBox API response body did not match the expected shape',
    );
    throw new TorboxApiError(`TorBox API response shape mismatch: ${context}`, context);
  }

  return dataCheck.data.data;
}
