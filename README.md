# Mars College MCP

An authenticated MCP resource server for members' own agents. Express + TypeScript, official MCP SDK, stateless Streamable HTTP at `/mcp`.

**Current scope:** Discord-backed authorization plus read-only, explicitly role-gated files. With no operator configuration, only the packaged synthetic demonstration is available. Local operators can instead select an external catalog/context root; `list_resources` and `read_resource` expose the same permitted documents as native MCP discovery/reads. `mars_lookup` still returns two introductory facts. No private resource inventory is included.

## Local setup

Requirements: Node 22.13+ (use a maintained Node 22/24 LTS), npm, and Python 3.11+ for the optional helper. The scripts explicitly enable Node's SQLite API for runtimes where it is still experimental; an experimental-feature warning is expected on those versions.

```sh
npm ci
cp .env.example .env
chmod 600 .env
# Fill Discord settings in .env, then:
npm run build
npm start
```

`npm run dev` runs the TypeScript entrypoint with a watcher. Without Discord configuration the server still serves health/discovery and rejects new login attempts with 503. There are no development bearer tokens or authentication bypasses.

## Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications), create/configure an application and register the appropriate exact OAuth redirect:

- Local: `http://localhost:4400/auth/discord/callback`
- Hosted: `https://mcp.mars.college/auth/discord/callback`

Configure `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_GUILD_ID`. Login requests `identify guilds.members.read`, retrieves the user's identity and target-guild membership, and rejects non-members and memberships still pending Discord screening. No bot token is required. Credentials are only sent server-to-server to Discord.

Find the client ID/secret under the application's OAuth2 settings. To copy the guild and role IDs, enable Discord **User Settings → Advanced → Developer Mode**; right-click the server for **Copy Server ID**, and use **Server Settings → Roles** to copy the chosen role's ID. Create/assign a temporary test role if desired. Store the secret in your private env file, not chat or Git. The application does not need a bot installation or Administrator permission; creating/assigning a server role may require a role manager.

`DISCORD_ROLE_MAP` maps immutable Discord role IDs to community role names:

```dotenv
DISCORD_ROLE_MAP={"123456789012345678":"demo-reader","234567890123456789":"organizer"}
```

Every accepted guild member gets `member`. Other roles are explicitly mapped; Discord display names are not used. Roles are exposed as `req.auth.extra.roles`, alongside `subject`, `username`, and `membershipAt`, and through `GET /auth/me`. They are not OAuth scopes: the only supported scope is `mars.read`.

## Role-gated file demonstration

The catalog definition is `config/mars/resources.json`. It grants the `demo-reader` community role access to `mars://demo/role-gated`, backed by `resources/demo/role-gated.txt`. That file contains invented "Copper Finch" telescope notes, not community history.

To use a real Discord role, map **its numeric ID** to `demo-reader` in `DISCORD_ROLE_MAP`, then restart the service. Log in with an account holding that role:

```sh
python3 skills/mars-mcp/scripts/mars.py login --no-browser
python3 skills/mars-mcp/scripts/mars.py me
python3 skills/mars-mcp/scripts/mars.py call list_resources
python3 skills/mars-mcp/scripts/mars.py call read_resource --arguments '{"uri":"mars://demo/role-gated"}'
python3 skills/mars-mcp/scripts/mars.py logout
```

Expected behavior:

| Principal | Discovery | Direct read |
|---|---|---|
| Guild member with mapped role | Document URI/name/description visible | File contents returned |
| Guild member without mapped role | Empty resource list | Same not-found result as an unknown URI |
| Missing/expired/revoked token | 401 | 401 |

Repeat login with an ordinary guild member without the role. Alternatively, remove the role from the test account, **log out, then log in again**, and repeat the commands. Existing tokens retain their membership snapshot for at most 15 minutes; removing a Discord role is not immediate revocation. `logout` revokes the current token immediately.

Native MCP clients can use `resources/list`, `resources/read`, and `resources/templates/list` (empty). The helper-compatible `list_resources` / `read_resource` tools use the same authorized set. Client arguments and headers cannot grant roles, and file paths are never accepted from callers.

The catalog's required `allowRoles` array permits any matching role; an empty list denies everyone. Policy and file contents are loaded together once per app startup, so restart after changing them. The image copies only the explicit synthetic file and demo catalog. **Do not put private documents in `resources/demo` or copy operator data into the image.**

## Local operator catalog

Keep private manifests and context **outside this checkout**, in a private operator-owned directory (0700, files 0600). Git exclusions for `private/` and `*.private.json` are defense in depth, not permission to store private material in the public repository. Neither credentials nor private resource names/policies belong in PRs.

To replace the packaged demo locally, set **both** `MARS_RESOURCE_CATALOG` (JSON manifest path) and `MARS_RESOURCE_ROOT` (context directory) in your private `.env`. Unset both to keep the demo-only default. The paths in `.env.example` are placeholders, not deployment settings. Paths resolve relative to the process working directory unless absolute; use absolute operator paths to avoid ambiguity. No hosting configuration is changed by this feature.

The external manifest uses the existing catalog shape. This example is entirely synthetic:

```json
{
  "resources": [
    {
      "uri": "mars://community/notes/welcome",
      "name": "Synthetic welcome note",
      "description": "Example operator-selected text",
      "file": "notes/welcome.md",
      "allowRoles": ["member"]
    }
  ]
}
```

Place the corresponding UTF-8 text file at `notes/welcome.md` under the configured root. Entries support nested relative files, not filesystem paths supplied by clients. All files are returned as `text/plain`; each must be a regular file no larger than 64 KiB. The loader rejects absolute paths, traversal segments, symlink escapes, duplicate URIs, missing role policies, and malformed configuration before the app starts. A partial configuration fails closed rather than silently serving the demo. A custom catalog replaces, rather than merges with, the packaged catalog.

`createApp(config, { resourceCatalogPath, resourceRoot })` provides the same explicit local configuration for embedders/tests. The entrypoint alone reads the two environment variables; separate app instances retain independent snapshots. Discovery and both read paths share the exact same role-filtered set; hidden and unknown resources produce the same not-found response. There is no file-writing API, execution, directory browsing, role grant, or client-selectable root.

Use only content and `allowRoles` policies the organizers have approved. Authentication alone does not authorize data exposure, and a local configuration is not approval for a production cutover. The Containerfile remains demo-only, with no operator mounts or data copies.

## Permissionless public contributions

Anyone may fork this public repository and submit a PR proposing public text files and catalog entries; no Discord role, organizer privilege, or repository write access is required to **submit**. Add only material you have the right to publish, with an explicit proposed `allowRoles` policy, and describe the intended audience. Never include credentials, private manifests, private context, or sensitive resource metadata.

Maintainers review content, provenance, and audience policy before accepting any addition for exposure. A proposed public file/catalog entry is not automatically served: the accepted catalog/root selected by an operator must include it. The production image explicitly packages only the demo today, so accepting other public data for that image also requires a reviewed packaging change. Permissionless submission is **not** an automatic access grant, authorization to deploy, or permission to execute PR code; maintainers must not run untrusted PR code with credentials or private context.


## Normal MCP-client authorization

Point an OAuth-capable Streamable HTTP client at `https://mcp.mars.college/mcp` (or `http://localhost:4400/mcp`). The flow is:

1. An unauthenticated request returns 401 with a protected-resource metadata link.
2. The client discovers this service's authorization endpoints and dynamically registers a public client.
3. Authorization code + mandatory S256 PKCE opens the browser, identifies the client/return address, and offers Discord login.
4. After guild/role lookup, the user explicitly approves their account, client, and read permission.
5. A one-time code returns to the registered redirect. The client exchanges it for a Mars bearer token bound to this `/mcp` resource.

Implemented endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728 resource discovery; root metadata path also works |
| `GET /.well-known/oauth-authorization-server` | Issuer and supported OAuth endpoints |
| `POST /register` | Dynamic public-client registration (`token_endpoint_auth_method: none`) |
| `GET, POST /authorize` | Authorization code flow, S256 PKCE, `resource=<PUBLIC_URL>/mcp` |
| `POST /token` | Form-encoded code exchange; same client, redirect, PKCE verifier, and resource required |
| `POST /revoke` | Form-encoded token revocation, bound to its registered client |
| `GET /auth/discord/callback` | Upstream Discord OAuth callback |

Redirects must be HTTPS or HTTP loopback, with no credentials, fragments, or wildcards. Native loopback clients may change only the registered callback's port, as RFC 8252 requires. The token exchange must match the **actual redirect used for that authorization**, including its port. Public-client registration is not authentication and grants no archive access. Client names are unverified labels, shown together with the return address before consent.

Only authorization-code grants are advertised. Registration can narrow a client's requested grant list to `authorization_code`; refresh tokens and confidential-client authentication are not supported. Clients reauthorize when a session expires. This is an OAuth authorization server, not an OpenID Connect identity provider: there are no ID tokens or UserInfo endpoint.

## Agent helper / device login

The portable skill is `skills/mars-mcp/`; install that directory into the agent client's skill directory, retaining its script. No global skill configuration is changed automatically. The standard-library helper handles credentials without displaying them to the agent:

```sh
export MARS_MCP_URL=http://localhost:4400
python3 skills/mars-mcp/scripts/mars.py login --no-browser
# Open the displayed URL, enter the code, log in with Discord, approve.
python3 skills/mars-mcp/scripts/mars.py me
python3 skills/mars-mcp/scripts/mars.py tools
python3 skills/mars-mcp/scripts/mars.py call mars_lookup --arguments '{"topic":"about"}'
python3 skills/mars-mcp/scripts/mars.py logout
```

`--base-url URL` before the subcommand overrides `MARS_MCP_URL`. Without `--no-browser`, login attempts to open a browser. The helper stores origin-bound credentials under `$XDG_CONFIG_HOME/mars-mcp/` (default `~/.config/mars-mcp/`) with directory mode 0700 and file mode 0600. It refuses redirects rather than forwarding bearer credentials and accepts HTTP only on loopback. Never paste tokens into chat, URLs, or checked-in configuration.

The helper's JSON API is `POST /auth/device`, `POST /auth/token` (poll with `device_code`), `GET /auth/me`, and `POST /auth/revoke`. `/auth/verify` is the browser code-entry page. This is a dedicated device-style helper flow, **not advertised as an RFC 8628 grant at `/token`**. Device requests expire after ten minutes, enforce poll backoff, and deliver a credential only once after browser-bound approval.

## Credential lifetime and storage

- Opaque Mars access tokens expire at most `AUTH_SESSION_TTL` seconds after the live Discord membership check (default 900, range 60–900). Consent delay cannot extend that deadline.
- Membership/role changes take effect on the next login and no later than the current session's expiry. There is no live Discord lookup on every tool call, nor immediate push revocation from Discord.
- `/revoke` or helper `logout` immediately revokes that Mars credential. Other independently authorized sessions are unaffected. If the server cannot be reached, deleting local credentials alone does not revoke them remotely.
- Discord access/refresh tokens are never persisted or returned to clients. Mars bearer tokens, authorization codes, device secrets, browser secrets, and upstream OAuth state are stored by hash, not raw credential value.
- A private SQLite database persists client registrations, pending authorizations, hashed sessions, and rate counters across restarts. Expired state is cleaned on startup/writes. Losing it invalidates all registrations and sessions.
- The native default is `~/.local/state/mars-mcp/auth.sqlite` (respects `XDG_STATE_HOME`). `AUTH_DATABASE_PATH` can override it. Use a dedicated 0700 parent directory; the database is 0600.
- Authorization responses are non-cacheable. Browser flows use HttpOnly/SameSite cookies, CSRF validation, single-use state, explicit consent, and restrictive CSP. Never enable query-string access logging for `/auth/discord/callback`: Discord returns a short-lived code in that URL. Do not log Authorization headers or request bodies.

## Operations and hosting

Generic hosting examples and read-only checks live in
[mars-college/mars-infra](https://github.com/mars-college/mars-infra).
They are not a record of an existing deployment. Local verification does not
establish live readiness.

Keep actual computers, OS accounts, network topology, storage locations,
credentials, deployment history and operator runbooks outside public source.
Before any cutover, agree with the operators on Discord configuration,
authorization policy, persistent auth state, migration and rollback. Confirm
the deployed revision and exercise real login and synthetic authorized reads
before announcing readiness. Do not silently replace a working issuer.

## Private resources

An operator may select a private catalog/root using the configuration above.
Do not publish private manifests, resource metadata or files, or copy them into
the image. Content authorization does not make public metadata private.

Repository maintainership does not authorize access to community data.
Approve each resource's audience before exposing it; the default image serves
only the synthetic demonstration.

## Verification

```sh
npm ci
npm run build
npm test
npm run test:helper
npm run smoke
```

`npm run smoke` starts the compiled app on an ephemeral loopback port and
uses a temporary SQLite database plus **synthetic Discord responses**. It
follows real discovery, PKCE, browser consent, token exchange, MCP initialization,
role-gated native and tool reads, role removal on fresh login, and revocation.
It never loads `.env`, contacts Discord, or reads the private archive. This is
a reproducible local service proof, not real Discord or live-host verification.

Tests cover Discord membership denial, role mapping, browser/CSRF/state binding, explicit consent, PKCE/client/redirect/resource binding, code/device replay, expiry, revocation, persistence, safe client redirects, helper credential permissions, and refusal to forward bearer tokens across redirects. The RBAC integration test follows Discord-inherited roles through token issuance to both native MCP resources and tools, including role removal on fresh login, hidden metadata, direct-read denial, and isolation between sessions. Additional throwaway catalog fixtures cover independent app snapshots, a custom catalog alongside a default app, unchanged native/tool authorization, required policies, duplicate URIs, traversal/absolute paths, symlink escapes, regular-file enforcement, and the 64 KiB byte limit; these fixtures contain no private community data.

Local running-service verification exercised the helper through a real browser approval page and authenticated MCP calls, and the official MCP SDK through discovery → registration → PKCE → consent → token exchange → tool call → revocation. Discord's upstream responses were mocked in isolated temporary fixtures; no production auth bypass exists. **Real Discord configuration and hosted operation remain unverified.**

The role-gated file was also exercised through the running helper: the mapped-role account discovered/read one document, while an ordinary member discovered none and could not retrieve the known URI. Both accounts used the actual OAuth/device endpoints with mocked Discord upstream responses, then revoked their sessions.
