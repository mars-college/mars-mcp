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
 * means replacing `createVerifier()` and nothing outside this file.
 *
 * Until an authorization server is chosen, tokens come from a static allowlist in
 * MARS_STUB_TOKENS. This is not suitable for anything but development.
 *
 * Format: comma-separated `token:subject:scope|scope` entries. Tokens and subjects
 * may not themselves contain `:` — a malformed entry is rejected at startup rather
 * than silently truncated.
 */
export interface StubToken {
  token: string;
  subject: string;
  scopes: string[];
}

/**
 * Entries are secrets, so parse errors identify the offending entry by position,
 * never by content. (One branch names the subject, which is an identity, not a
 * credential.) Printing the entry itself would put a live bearer token in the journal.
 */
export function parseStubTokens(raw: string | undefined): StubToken[] {
  if (!raw) return [];

  const parsed: StubToken[] = [];
  const seen = new Set<string>();

  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, index) => {
      const position = `entry ${index + 1}`;
      const fields = entry.split(':').map((field) => field.trim());

      if (fields.length !== 3) {
        throw new Error(
          `MARS_STUB_TOKENS ${position} is malformed: expected ` +
            `token:subject:scope|scope, got ${fields.length} colon-separated ` +
            `field(s). Tokens and subjects may not contain ":".`,
        );
      }

      const [token = '', subject = '', scopeField = ''] = fields;
      if (!token || !subject) {
        throw new Error(`MARS_STUB_TOKENS ${position} has an empty token or subject.`);
      }

      const scopes = scopeField
        .split('|')
        .map((scope) => scope.trim())
        .filter(Boolean);
      if (scopes.length === 0) {
        throw new Error(
          `MARS_STUB_TOKENS ${position} ("${subject}") lists no scopes, so every ` +
            `request using it would be rejected.`,
        );
      }

      if (seen.has(token)) {
        throw new Error(
          `MARS_STUB_TOKENS ${position} duplicates an earlier token; the later ` +
            `entry would silently shadow it.`,
        );
      }
      seen.add(token);

      parsed.push({ token, subject, scopes });
    });

  return parsed;
}

/** Stub tokens do not really expire, but the SDK requires an expiry — mint a rolling one. */
const STUB_TTL_SECONDS = 60 * 60;

export class StubTokenVerifier implements OAuthTokenVerifier {
  private readonly byToken: Map<string, StubToken>;
  private readonly resourceUrl: URL;

  constructor(tokens: StubToken[], resource: string) {
    this.byToken = new Map(tokens.map((t) => [t.token, t]));
    // Constant for the process lifetime; building it per request allocates for nothing.
    this.resourceUrl = new URL(resource);
  }

  get size(): number {
    return this.byToken.size;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const match = this.byToken.get(token);
    if (!match) {
      // Deliberately not "or expired": a stub token cannot expire, so saying so
      // would send an operator chasing the wrong hypothesis.
      throw new InvalidTokenError('Unrecognized access token');
    }
    return {
      token,
      // With a real authorization server these come from the token itself.
      clientId: match.subject,
      scopes: match.scopes,
      // Reserved for RFC 8707 audience binding. Nothing enforces it yet — the SDK's
      // bearer middleware checks scopes and expiry only — so a real verifier must
      // compare the token's `aud` against this itself.
      resource: this.resourceUrl,
      expiresAt: Math.floor(Date.now() / 1000) + STUB_TTL_SECONDS,
      extra: { subject: match.subject },
    };
  }
}

/**
 * The seam. Owns its own configuration so the rest of the app depends only on the
 * `OAuthTokenVerifier` interface — a real JWT or introspection verifier drops in
 * here without `index.ts` changing.
 */
export function createVerifier(resource: string): OAuthTokenVerifier {
  // A bad entry must not take the process down. Throwing here happens at module
  // scope, before listen(), so `Restart=on-failure` would crash-loop forever with
  // no /healthz to tell an operator "bad config" apart from "box is down".
  // Starting with zero tokens fails closed — every request 401s — while keeping
  // the health probe green and the reason in the journal.
  let tokens: StubToken[] = [];
  try {
    tokens = parseStubTokens(process.env.MARS_STUB_TOKENS);
  } catch (err) {
    console.error(
      '[mars-mcp] MARS_STUB_TOKENS could not be parsed; starting with NO tokens, ' +
        'so every request will be rejected:',
      err instanceof Error ? err.message : err,
    );
  }

  const verifier = new StubTokenVerifier(tokens, resource);
  if (verifier.size === 0) {
    console.warn(
      '[mars-mcp] MARS_STUB_TOKENS is empty — every request will be rejected. ' +
        'Set it in .env (see .env.example).',
    );
  } else {
    // Count only, never the tokens themselves.
    console.log(`[mars-mcp] stub tokens  ${verifier.size}`);
  }
  return verifier;
}
