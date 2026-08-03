import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseEnvelope, TorboxApiError } from './envelope.js';
import {
  mylistResponseSchema,
  singleTorrentResponseSchema,
  type TorboxTorrent,
} from './schemas.js';

const API_BASE_URL = 'https://api.torbox.app/v1/api';
const WEBDAV_BASE_URL = 'https://webdav.torbox.app';

async function torboxFetch(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.torboxApiKey}`,
      ...init?.headers,
    },
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    logger.error({ url, status: response.status }, 'TorBox response body was not valid JSON');
    throw new TorboxApiError(`TorBox returned a non-JSON response (HTTP ${response.status})`, url);
  }
  return body;
}

/** GET /torrents/mylist?bypass_cache=true — the full library in one call.
 * Per-torrent `files` may or may not be present; callers must check for
 * `undefined` (not just falsy) and fall back to getTorrentById when absent. */
export async function getMylist(): Promise<TorboxTorrent[]> {
  const url = `${API_BASE_URL}/torrents/mylist?bypass_cache=true`;
  const body = await torboxFetch(url);
  return parseEnvelope(body, mylistResponseSchema, 'GET /torrents/mylist');
}

/** GET /torrents/mylist?bypass_cache=true&id=N — data is a single object, not
 * an array, and includes `files`. Used when the bulk mylist response omitted
 * per-file arrays for this torrent. */
export async function getTorrentById(torboxId: number): Promise<TorboxTorrent> {
  const url = `${API_BASE_URL}/torrents/mylist?bypass_cache=true&id=${torboxId}`;
  const body = await torboxFetch(url);
  return parseEnvelope(body, singleTorrentResponseSchema, `GET /torrents/mylist?id=${torboxId}`);
}

/**
 * GET /torrents/requestdl?...&redirect=true — TorBox responds with a 302 to
 * a signed, short-lived CDN URL. Fetched with redirect:'manual' so we read
 * the Location header ourselves instead of following it: the whole point is
 * handing this URL to our own /play/:fileId redirect, never to the client
 * directly (LOCKED, §5.5 — TORBOX_API_KEY must never appear in a URL we
 * return). Server-side only; do not expose this function outside src/http's
 * play route once that exists.
 */
export async function getPlaybackUrl(torrentId: number, fileId: number): Promise<string> {
  const url = `${API_BASE_URL}/torrents/requestdl?token=${encodeURIComponent(config.torboxApiKey)}&torrent_id=${torrentId}&file_id=${fileId}&redirect=true`;
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (!location) {
    logger.error(
      { torrentId, fileId, status: response.status },
      'TorBox requestdl did not return a redirect',
    );
    throw new TorboxApiError(
      'TorBox requestdl did not return a Location header',
      'GET /torrents/requestdl',
    );
  }
  return location;
}

/**
 * POST https://webdav.torbox.app/refresh/ — the WebDAV view otherwise only
 * updates every 15 minutes. Best-effort: this repo's auth mechanism for the
 * WebDAV host isn't confirmed against a live account (may differ from the
 * REST API's bearer token), and force-refresh is an optimisation, not a
 * correctness requirement, so failures are logged and swallowed rather than
 * aborting ingest.
 */
export async function refreshWebdav(): Promise<boolean> {
  try {
    const response = await fetch(`${WEBDAV_BASE_URL}/refresh/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.torboxApiKey}` },
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        'WebDAV refresh returned a non-OK status; continuing anyway',
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, 'WebDAV refresh failed; continuing without it');
    return false;
  }
}
