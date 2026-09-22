# Mars College MCP

An authenticated MCP resource server for members' own agents. Express + TypeScript, official MCP SDK, stateless Streamable HTTP at `/mcp`.

**Current scope:** Discord-backed authorization plus a synthetic, role-gated file demonstration. `list_resources` and `read_resource` expose the same permitted documents as native MCP resource discovery/reads. `mars_lookup` still returns two introductory facts. The private Discord archive remains unexposed; this demo does not define its access policies.

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

The demo policy's `allowRoles` array permits any matching role; an empty list denies everyone. Policy and file contents are loaded together at startup, so restart after changing them. This is a small packaged demonstration, not a general archive loader: the image copies only the explicit synthetic file and demo catalog. **Do not put private documents in `resources/demo` or copy the real archive into the image.**


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

## Deploy on eden2 — preserve isolation

The existing service runs as **`mars` uid 1001**, using rootless Podman and a user systemd unit. Caddy terminates TLS at `mcp.mars.college`; only `127.0.0.1:4400` is published. Do not change `/opt/eden3`, Eden systemd units, the Docker socket/group, or uid 1000 (`eden`).

This change requires **one new private state directory**. As root, create it once:

```sh
install -d -m 0700 -o mars -g mars /srv/mars-mcp-state
```

Update `/home/mars/mars-mcp.env` privately (keep mode 0600):

- `PORT=4400`, `BIND_HOST=0.0.0.0`, `PUBLIC_URL=https://mcp.mars.college`.
- The three `DISCORD_*` application/guild settings and `DISCORD_ROLE_MAP`.
- Remove the previous static-token configuration and separate issuer override; this service now issues its own credentials.

The updated unit keeps `/srv/mars-mcp-data:/data:ro` and `--userns=keep-id:uid=1000,gid=1000` unchanged. It adds `/srv/mars-mcp-state:/state:rw` and fixes `AUTH_DATABASE_PATH=/state/auth.sqlite`. Keep both host data/state directories private to `mars`. **Never copy the archive or credentials into image layers.** Backups of auth state are private too; take a SQLite-consistent backup, or stop Mars before copying state. Restoring an older auth backup can resurrect a session revoked after that backup; prefer fresh auth state/relogin if this matters.

Develop/push locally and transfer source via rsync; the host has no GitHub credentials. Exclude `.env*`, credentials, SQLite files, `node_modules`, and temporary artifacts from transfers. Then, as `mars` (`su - mars` provides `XDG_RUNTIME_DIR`):

```sh
cd /srv/mars-mcp
podman build -t mars-mcp:latest .
install -D -m644 mars-mcp.service ~/.config/systemd/user/mars-mcp.service
systemctl --user daemon-reload
systemctl --user restart mars-mcp
systemctl --user status mars-mcp
journalctl --user -u mars-mcp
```

The first deployment invalidates the old static-token workflow. Coordinate with Gene and configure Discord before switching the service; do not deploy an unconfigured issuer over the working development service unexpectedly. This implementation has not been deployed to eden2.

SQLite is single-host local state: keep one service instance, not multiple independent databases behind a load balancer. SDK OAuth endpoint limits and SQLite-backed helper/MCP limits apply; forwarding headers are not trusted. Behind Caddy, IP-based limits share the proxy address. Plan edge limits/trusted proxy configuration before broader rollout. After any host reboot, preserve the existing operational check `systemctl is-active caddy`; no Caddy/system-wide changes are part of this work.

## Private archive boundary

The archive is at `/srv/mars-mcp-data/discord` on the host and `/data/discord` in the container, configured by `DISCORD_ARCHIVE_DIR`. It remains a read-only mount in a 0700 `mars:mars` directory; `eden` must not gain direct file access. Do not alter the user namespace mapping or make a debugging copy world-readable. Root/Docker control can bypass filesystem permissions; this is not a defense against host root.

Authentication does not settle which summaries or raw history a member should see. No archive-backed tool is added here. Settle document authorization/redaction with Gene before connecting retrieval.

## Verification

```sh
npm run build
npm test
npm run test:helper
```

Tests cover Discord membership denial, role mapping, browser/CSRF/state binding, explicit consent, PKCE/client/redirect/resource binding, code/device replay, expiry, revocation, persistence, safe client redirects, helper credential permissions, and refusal to forward bearer tokens across redirects. The RBAC integration test follows Discord-inherited roles through token issuance to both native MCP resources and tools, including role removal on fresh login, hidden metadata, direct-read denial, and isolation between sessions.

Local running-service verification exercised the helper through a real browser approval page and authenticated MCP calls, and the official MCP SDK through discovery → registration → PKCE → consent → token exchange → tool call → revocation. Discord's upstream responses were mocked in isolated temporary fixtures; no production auth bypass exists. **Live Discord application configuration and rootless Podman deployment still need verification with the real credentials and target host.**

The role-gated file was also exercised through the running helper: the mapped-role account discovered/read one document, while an ordinary member discovered none and could not retrieve the known URI. Both accounts used the actual OAuth/device endpoints with mocked Discord upstream responses, then revoked their sessions.
