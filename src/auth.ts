import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

/**
 * TEMPORARY token verification.
 *
 * The MCP authorization spec splits responsibilities: this process is an OAuth 2.1
 * *resource server* that only validates tokens, while a separate *authorization
 * server* handles Martian login, consent and issuance. That split is deliberate and
 * this file is the seam — swapping the stub for real JWT/introspection validation
 * should not require touching anything else.
 *
 * Until an authorization server is chosen, tokens come from a static allowlist in
 * MARS_STUB_TOKENS. This is not suitable for anything but development.
 *
 * Format: comma-separated `token:subject:scope|scope` entries.
 */
export interface StubToken {
  token: string;
  subject: string;
  scopes: string[];
}

export function parseStubTokens(raw: string | undefined): StubToken[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [token, subject, scopes] = entry.split(':');
      if (!token || !subject) {
        throw new Error(`MARS_STUB_TOKENS entry is malformed: "${entry}"`);
      }
      return {
        token,
        subject,
        scopes: (scopes ?? '').split('|').map((s) => s.trim()).filter(Boolean),
      };
    });
}

/** Stub tokens do not really expire, but the SDK requires an expiry — mint a rolling one. */
const STUB_TTL_SECONDS = 60 * 60;

export class StubTokenVerifier implements OAuthTokenVerifier {
  private readonly byToken: Map<string, StubToken>;

  constructor(
    tokens: StubToken[],
    private readonly resource: string,
  ) {
    this.byToken = new Map(tokens.map((t) => [t.token, t]));
  }

  get size(): number {
    return this.byToken.size;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const match = this.byToken.get(token);
    if (!match) {
      throw new InvalidTokenError('Unknown or expired access token');
    }
    return {
      token,
      // With a real authorization server these come from the token itself.
      clientId: match.subject,
      scopes: match.scopes,
      resource: new URL(this.resource),
      expiresAt: Math.floor(Date.now() / 1000) + STUB_TTL_SECONDS,
      extra: { subject: match.subject },
    };
  }
}
