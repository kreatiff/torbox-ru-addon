import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { OAuth2Client, type LoginTicket } from 'google-auth-library';
import { config } from '../config.js';

interface SessionUser {
  email: string;
  name: string | null;
  picture: string | null;
}

declare module '@fastify/secure-session' {
  interface SessionData {
    user: SessionUser;
    oauthState: string;
    codeVerifier: string;
  }
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

function codeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.get('/auth/google', async (request, reply) => {
    const state = base64UrlEncode(randomBytes(32));
    const codeVerifier = generateCodeVerifier();

    request.session.set('oauthState', state);
    request.session.set('codeVerifier', codeVerifier);

    const redirectUri = `${config.publicBase}/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });

    return reply.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  app.get('/auth/google/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    const storedState = request.session.get('oauthState');
    const codeVerifier = request.session.get('codeVerifier');

    if (!code || !state || state !== storedState || !codeVerifier) {
      app.log.warn('OAuth callback failed state/verifier validation');
      return reply.code(400).send('Invalid OAuth callback');
    }

    const redirectUri = `${config.publicBase}/auth/google/callback`;

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }),
      });
    } catch (err) {
      app.log.error({ err }, 'Failed to contact Google token endpoint');
      return reply.code(502).send('OAuth token exchange failed');
    }

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      app.log.warn({ status: tokenResponse.status, body: text }, 'Google token endpoint error');
      return reply.code(502).send('OAuth token exchange failed');
    }

    const tokenData = (await tokenResponse.json()) as {
      id_token?: string;
      access_token?: string;
    };

    if (!tokenData.id_token) {
      app.log.warn('Google token response missing id_token');
      return reply.code(502).send('OAuth token exchange failed');
    }

    const oauthClient = new OAuth2Client(config.googleClientId);
    let payload: ReturnType<LoginTicket['getPayload']>;
    try {
      const ticket = await oauthClient.verifyIdToken({
        idToken: tokenData.id_token,
        audience: config.googleClientId,
      });
      payload = ticket.getPayload();
    } catch (err) {
      app.log.error({ err }, 'Failed to verify Google ID token');
      return reply.code(502).send('OAuth token verification failed');
    }

    if (!payload?.email_verified || !payload.email) {
      return reply.code(403).send('Google account email is not verified');
    }

    const email = payload.email.toLowerCase();
    if (!config.allowedEmails.includes(email)) {
      app.log.warn({ email }, 'Google login rejected: email not in ALLOWED_EMAILS');
      return reply.code(403).send('This account is not authorized to access this application');
    }

    request.session.set('user', {
      email,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
    });

    return reply.redirect('/admin/');
  });

  app.get('/auth/me', async (request, reply) => {
    const user = request.session.get('user');
    if (!user) {
      return reply.code(401).send({ authenticated: false });
    }
    return { authenticated: true, user };
  });

  app.post('/auth/logout', async (request, reply) => {
    request.session.delete();
    return reply.send({ success: true });
  });
}

export async function verifySession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const user = request.session.get('user');
  if (!user) {
    await reply.code(401).send({ error: 'Unauthorized' });
  }
}
