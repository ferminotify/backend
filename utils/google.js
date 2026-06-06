import { OAuth2Client } from 'google-auth-library';
import dotenv from 'dotenv';
import { API_URL, URL } from './config.js';
dotenv.config();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Where Google sends the user back. Defaults to the production callback.
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || `${API_URL}/user/auth/google/callback`;

// Base URL of the SPA the user lands on after the OAuth dance. The first entry
// of FRONTEND_ORIGIN (used by CORS) wins, falling back to the prod site.
export const FRONTEND_BASE =
  (process.env.FRONTEND_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean)[0] || URL;

export function isGoogleConfigured() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

export function getOAuthClient() {
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

// Build the Google consent screen URL for the given CSRF state.
export function buildConsentUrl(state) {
  return getOAuthClient().generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
  });
}

// Exchange the authorization code and verify the returned id_token.
// Returns the verified payload: { sub, email, email_verified, given_name, family_name, name }.
export async function exchangeCodeForProfile(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error('No id_token returned by Google');
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}
