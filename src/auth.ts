import { createHash, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError, InvalidTokenError, UnsupportedGrantTypeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { AuthStore, hash, now, secret } from './auth-store.js';
import type { AuthConfig, AuthorizationCode, LoginFlow, Principal, StoredAccess } from './auth-types.js';

const DEVICE_CLIENT = 'mars-agent-helper';
const SCOPE = 'mars.read';

export function validRedirect(value: string): boolean {
  if (value.length > 2048 || value.includes('*') || value.includes('#')) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
      url.href === value;
  } catch { return false; }
}

export class MarsAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(private readonly store: AuthStore, private readonly config: AuthConfig) {
    this.clientsStore = {
      getClient: (id) => id === DEVICE_CLIENT ? undefined : store.get<OAuthClientInformationFull>('client', id),
      registerClient: (input) => {
        const grants = input.grant_types ?? ['authorization_code'];
        const responses = input.response_types ?? ['code'];
        if (input.token_endpoint_auth_method !== 'none' || input.client_secret ||
            !grants.includes('authorization_code') || grants.some(grant => !['authorization_code', 'refresh_token'].includes(grant)) ||
            responses.length !== 1 || responses[0] !== 'code' ||
            (input.scope !== undefined && input.scope !== SCOPE) ||
            input.redirect_uris.length < 1 || input.redirect_uris.length > 10 ||
            !input.redirect_uris.every(validRedirect)) {
          throw new InvalidClientMetadataError('Public authorization-code clients require HTTPS or loopback redirects and mars.read scope');
        }
        const client: OAuthClientInformationFull = {
          client_id: secret(), client_id_issued_at: now(),
          client_name: input.client_name?.slice(0, 200),
          redirect_uris: [...new Set(input.redirect_uris)],
          token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
          response_types: ['code'], scope: SCOPE,
        };
        store.put('client', client.client_id, client, Number.MAX_SAFE_INTEGER);
        return client;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!this.config.discordClientId || !this.config.discordClientSecret || !this.config.discordGuildId) {
      res.status(503).json({ error: 'temporarily_unavailable', error_description: 'Discord authorization is not configured' });
      return;
    }
    // RFC 8252 permits native clients to change only the loopback callback port.
    if (!validRedirect(params.redirectUri) || !client.redirect_uris.some(uri => redirectUriMatches(params.redirectUri, uri))) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Unregistered redirect URI' });
      return;
    }
    if (params.resource?.href !== this.config.resource) throw new InvalidTargetError('The mars resource is required');
    if (params.scopes?.length && (params.scopes.length !== 1 || params.scopes[0] !== SCOPE)) throw new InvalidScopeError('Only mars.read is supported');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('A valid S256 PKCE challenge is required');
    const flowId = secret();
    const flow: LoginFlow = {
      kind: 'oauth', clientId: client.client_id, clientName: client.client_name ?? 'Unnamed client',
      resource: this.config.resource, scope: SCOPE, expiresAt: now() + 600,
      status: 'pending', redirectUri: params.redirectUri, state: params.state,
      codeChallenge: params.codeChallenge,
    };
    this.store.put('flow', flowId, flow, flow.expiresAt);
    res.redirect(`${this.config.issuer}/auth/start?flow=${flowId}`);
  }

  private code(clientId: string, code: string): AuthorizationCode {
    const entry = this.store.get<AuthorizationCode>('code', hash(code));
    if (!entry || entry.clientId !== clientId) throw new InvalidGrantError('Invalid authorization code');
    return entry;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.code(client.client_id, code).codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    return this.store.transaction(() => {
      const entry = this.code(client.client_id, code);
      if (entry.redirectUri !== redirectUri || !client.redirect_uris.some(uri => redirectUriMatches(entry.redirectUri, uri))) throw new InvalidGrantError('Redirect URI mismatch');
      if (resource?.href !== this.config.resource || entry.resource !== this.config.resource) throw new InvalidTargetError('Resource mismatch');
      // The SDK validates PKCE before invoking this method, and then omits the verifier.
      if (verifier !== undefined) {
        const actual = createHash('sha256').update(verifier).digest('base64url');
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || actual.length !== entry.codeChallenge.length ||
            !timingSafeEqual(Buffer.from(actual), Buffer.from(entry.codeChallenge))) throw new InvalidGrantError('PKCE mismatch');
      }
      if (entry.scope !== SCOPE) throw new InvalidScopeError('Only mars.read is supported');
      const tokens = this.issueAccess(client.client_id, entry.principal);
      this.store.delete('code', hash(code));
      return tokens;
    });
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new UnsupportedGrantTypeError('Refresh tokens are not supported; authorize again');
  }

  issueAccess(clientId: string, principal: Principal): OAuthTokens {
    const time = now();
    const expiresAt = principal.membershipAt + Math.min(this.config.sessionTtl, 900);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= time || principal.membershipAt > time) throw new InvalidGrantError('Membership authorization has expired');
    const token = secret();
    const access: StoredAccess = { clientId, resource: this.config.resource, scopes: [SCOPE], principal, expiresAt };
    this.store.put('access', hash(token), access, expiresAt);
    return { access_token: token, token_type: 'Bearer', expires_in: expiresAt - time, scope: SCOPE };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.store.get<StoredAccess>('access', hash(token));
    if (!entry || entry.resource !== this.config.resource || entry.expiresAt <= now()) throw new InvalidTokenError('Invalid or expired access token');
    return { token, clientId: entry.clientId, scopes: entry.scopes, expiresAt: entry.expiresAt,
      resource: new URL(entry.resource), extra: { ...entry.principal } };
  }

  revokeAccess(token: string): void { this.store.delete('access', hash(token)); }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.store.transaction(() => {
      const entry = this.store.get<StoredAccess>('access', hash(request.token));
      if (entry?.clientId === client.client_id) this.revokeAccess(request.token);
    });
  }
}
