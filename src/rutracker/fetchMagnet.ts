import { config } from '../config.js';
import { logger } from '../logger.js';

const MAGNET_REGEX = /magnet:\?xt=urn:btih:[^"'\s<]+/i;

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export type FetchMagnetResult = { ok: true; magnet: string } | { ok: false; error: string };

interface FlareSolverrResponse {
  status?: string;
  message?: string;
  solution?: { response?: string };
}

/**
 * Fetches `topicUrl` through FlareSolverr (config.flaresolverrUrl) and pulls
 * the magnet link out of the solved page's HTML. RuTracker's Cloudflare
 * Turnstile challenge blocks a plain server-side fetch outright -- verified
 * directly against the live site (a bare request gets a 403 with
 * `cf-mitigated: challenge`; see docs/rutracker-scraper-plan.md).
 * FlareSolverr drives a real (undetected) Chromium instance to solve it
 * instead. The magnet is public on the topic page regardless of RuTracker
 * login state -- Cloudflare's challenge is the only barrier, not RuTracker's
 * own auth.
 *
 * Never throws: this is a manually-triggered action (the admin UI's
 * Download button, or a Discord notification link), so failures are
 * returned as a typed result for the caller to surface directly to the
 * human who triggered it, not swallowed the way the ingest pipeline's own
 * soft-fail steps are.
 */
export async function fetchMagnetLink(topicUrl: string): Promise<FetchMagnetResult> {
  if (!config.flaresolverrUrl) {
    return { ok: false, error: 'FLARESOLVERR_URL is not configured' };
  }

  let body: FlareSolverrResponse;
  try {
    const response = await fetch(`${config.flaresolverrUrl}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: topicUrl, maxTimeout: 60000 }),
    });
    body = (await response.json()) as FlareSolverrResponse;
  } catch (err) {
    logger.warn({ err, topicUrl }, 'FlareSolverr request failed');
    return { ok: false, error: 'Could not reach FlareSolverr' };
  }

  if (body.status !== 'ok') {
    logger.warn({ topicUrl, message: body.message }, 'FlareSolverr did not solve the challenge');
    return { ok: false, error: body.message ?? 'FlareSolverr did not solve the challenge' };
  }

  const html = body.solution?.response ?? '';
  const match = MAGNET_REGEX.exec(html);
  if (!match) {
    logger.warn({ topicUrl }, 'FlareSolverr solved the page but no magnet link was found in it');
    return { ok: false, error: 'No magnet link found on the topic page' };
  }

  return { ok: true, magnet: decodeHtmlEntities(match[0]) };
}
