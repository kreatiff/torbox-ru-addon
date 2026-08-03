import { pool } from '../pool.js';

/**
 * Fire-and-forget audit trail for `/play/:fileId` hits (§5.5: "it gives you
 * play_log, which reveals which mappings are actually being used and which
 * are quietly wrong"). No FK on file_id by design (§4) -- history should
 * outlive the row it refers to. Callers must not let a logging failure
 * block the redirect itself.
 */
export async function insertPlayLog(fileId: number, userAgent: string | null): Promise<void> {
  await pool.query('insert into play_log (file_id, user_agent) values ($1, $2)', [
    fileId,
    userAgent,
  ]);
}
