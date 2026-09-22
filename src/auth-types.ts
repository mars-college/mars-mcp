import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface AuthConfig {
  issuer: string;
  resource: string;
  databasePath: string;
  discordClientId: string;
  discordClientSecret: string;
  discordGuildId: string;
  roleMap: Record<string, string>;
  sessionTtl: number;
}

export interface Principal {
  subject: string;
  username: string;
  roles: string[];
  membershipAt: number;
}

export interface LoginFlow {
  kind: 'oauth' | 'device';
  clientId: string;
  clientName: string;
  resource: string;
  scope: 'mars.read';
  expiresAt: number;
  status: 'pending' | 'exchanging' | 'approval' | 'approved' | 'denied' | 'consumed';
  redirectUri?: string;
  state?: string;
  codeChallenge?: string;
  browserHash?: string;
  userCode?: string;
  principal?: Principal;
  lastPoll?: number;
  pollInterval?: number;
}

export interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: 'mars.read';
  codeChallenge: string;
  principal: Principal;
}

export interface StoredAccess {
  clientId: string;
  resource: string;
  scopes: string[];
  principal: Principal;
  expiresAt: number;
}

export type RegisteredClient = OAuthClientInformationFull;
