export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

/** Postgres unique_violation (23505) surfaced as a typed error. */
export class ConflictError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ConflictError';
  }
}

interface PgErrorLike {
  code?: string;
  detail?: string;
  message: string;
}

export function isPgError(err: unknown): err is PgErrorLike {
  return typeof err === 'object' && err !== null && 'code' in err;
}

export function toConflictError(err: unknown): ConflictError | undefined {
  if (isPgError(err) && err.code === '23505') {
    return new ConflictError(err.detail ?? err.message);
  }
  return undefined;
}
