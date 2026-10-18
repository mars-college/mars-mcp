#!/usr/bin/env python3
"""Mars MCP authentication and tool client (Python 3.10+, standard library only)."""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser


class ClientError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def base_url(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        host, port = parsed.hostname, parsed.port
        loopback = host == 'localhost'
        try:
            loopback = loopback or ipaddress.ip_address(host or '').is_loopback
        except ValueError:
            pass
        if (not host or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or parsed.path not in ('', '/')
                or parsed.scheme not in ('http', 'https')
                or (parsed.scheme == 'http' and not loopback)):
            raise ValueError()
        authority = f'[{host}]' if ':' in host else host
        if port is not None and port != (443 if parsed.scheme == 'https' else 80):
            authority += f':{port}'
        return f'{parsed.scheme}://{authority}'
    except ValueError:
        raise argparse.ArgumentTypeError('Use an HTTPS origin, or HTTP on literal loopback/localhost; no credentials, path, query or fragment') from None


def credential_path(base):
    root = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'mars-mcp'
    return root / (hashlib.sha256(base.encode()).hexdigest() + '.json')


def private_directory(path, create=False):
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ClientError('Credential directory must be owned by you and must not be a symlink.')
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ClientError('Credential directory must be private (chmod 700).')


def positive_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ClientError('Invalid server expiration or polling interval.')
    return value


def save_credentials(base, token, expires_in):
    if not isinstance(token, str) or not token or any(c.isspace() for c in token):
        raise ClientError('Invalid server credentials.')
    expires_in = positive_number(expires_in)
    path = credential_path(base)
    private_directory(path.parent, create=True)
    fd, temporary = tempfile.mkstemp(prefix='.credential-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump({'origin': base, 'access_token': token, 'expires_at': time.time() + expires_in}, stream)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_credentials(base):
    path = credential_path(base)
    try:
        private_directory(path.parent)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise ClientError('Credential file must be private and owned by you (chmod 600).')
            data = json.load(stream)
            if data['origin'] != base or positive_number(data['expires_at']) <= time.time():
                raise ClientError('Credentials expired or belong to another server. Run login again.')
            token = data['access_token']
            if not isinstance(token, str) or not token or any(c.isspace() for c in token):
                raise ValueError()
            return token
    except FileNotFoundError:
        raise ClientError('No saved credentials for this server. Run login first.') from None
    except (OSError, ValueError, KeyError, TypeError):
        raise ClientError('Invalid or unsafe saved credentials. Run login again.') from None


def request(base, path, *, method='GET', data=None, token=None, headers=None):
    outgoing = {'Accept': 'application/json'}
    outgoing.update(headers or {})
    if token:
        outgoing['Authorization'] = 'Bearer ' + token
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        outgoing['Content-Type'] = 'application/json'
    req = urllib.request.Request(base + path, data=body, headers=outgoing, method=method)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as response:
            raw = response.read().decode('utf-8')
            if response.headers.get_content_type() == 'text/event-stream':
                messages = []
                for event in raw.replace('\r\n', '\n').split('\n\n'):
                    lines = [line[5:].lstrip(' ') for line in event.split('\n') if line.startswith('data:')]
                    if lines:
                        messages.append(json.loads('\n'.join(lines)))
                payload = next((item for item in messages if isinstance(item, dict) and item.get('id') == (data or {}).get('id')), None)
            else:
                payload = json.loads(raw) if raw else None
            return response.status, payload, response.headers
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            raise ClientError('Server redirect refused; configure the final HTTPS origin directly.') from None
        try:
            payload = json.loads(exc.read())
        except ValueError:
            payload = None
        return exc.code, payload, exc.headers
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise ClientError('Server request failed or returned invalid JSON; check the origin and connection.') from None


def checked(base, path, **kwargs):
    status, payload, headers = request(base, path, **kwargs)
    if status == 401:
        raise ClientError('Session expired or revoked. Run login again.')
    if status == 403:
        raise ClientError('Access denied by server policy. Login does not grant additional rights.')
    if status >= 400:
        raise ClientError(f'Server returned HTTP {status}.')
    return payload, headers


def login(args):
    flow, _ = checked(args.base_url, '/auth/device', method='POST', data={})
    uri = flow['verification_uri']
    parsed = urllib.parse.urlsplit(uri)
    try:
        origin = base_url(urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', '')))
    except argparse.ArgumentTypeError:
        raise ClientError('Server supplied an unsafe verification URL.') from None
    if origin != args.base_url or parsed.fragment:
        raise ClientError('Verification URL must belong to the configured server.')
    code = flow['user_code']
    if not isinstance(code, str) or not code or not code.isascii() or any(not (c.isalnum() or c == '-') for c in code):
        raise ClientError('Invalid verification code.')
    interval = max(1, positive_number(flow.get('interval', 5)))
    deadline = time.monotonic() + positive_number(flow['expires_in'])
    print('Open:', uri, flush=True)
    print('Enter code:', code, flush=True)
    print('Check the code in your browser and explicitly approve access.', flush=True)
    if not args.no_browser:
        webbrowser.open(uri)
    while time.monotonic() < deadline:
        time.sleep(min(interval, max(0, deadline - time.monotonic())))
        if time.monotonic() >= deadline:
            break
        status, payload, _ = request(args.base_url, '/auth/token', method='POST', data={'device_code': flow['device_code']})
        if status < 400 and isinstance(payload, dict) and payload.get('access_token'):
            if payload.get('token_type', '').lower() != 'bearer':
                raise ClientError('Unsupported server token type.')
            save_credentials(args.base_url, payload['access_token'], payload['expires_in'])
            print('Logged in. Short-lived credentials saved privately.', flush=True)
            return
        error = payload.get('error') if isinstance(payload, dict) else None
        if error == 'authorization_pending':
            continue
        if error == 'slow_down':
            interval += 5
            continue
        if error == 'access_denied':
            raise ClientError('Login denied. Confirm guild membership and permitted Discord roles.')
        if error == 'expired_token':
            break
        raise ClientError(f'Login failed (HTTP {status}); start login again.')
    raise ClientError('Device login expired. Run login again.')


def mcp(base, token, method, params):
    headers = {'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25'}

    def rpc(message):
        payload, received = checked(base, '/mcp', method='POST', data=message, token=token, headers=headers)
        session = received.get('Mcp-Session-Id')
        if session:
            headers['Mcp-Session-Id'] = session
        if 'id' not in message:
            return None
        if not isinstance(payload, dict) or payload.get('jsonrpc') != '2.0' or payload.get('id') != message['id']:
            raise ClientError('Invalid MCP response.')
        if 'error' in payload:
            # The caller emits the original structured JSON-RPC error after redacting credentials.
            return payload
        if 'result' not in payload:
            raise ClientError('Invalid MCP response.')
        return payload

    initialized = rpc({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
        'protocolVersion': headers['MCP-Protocol-Version'], 'capabilities': {},
        'clientInfo': {'name': 'mars-agent-helper', 'version': '1.0.0'}}})
    if 'error' in initialized:
        return initialized
    version = initialized['result'].get('protocolVersion')
    if version not in ('2025-11-25', '2025-06-18', '2025-03-26'):
        raise ClientError('Unsupported MCP protocol version.')
    headers['MCP-Protocol-Version'] = version
    rpc({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
    return rpc({'jsonrpc': '2.0', 'id': 2, 'method': method, 'params': params})


def emit(payload, token):
    print(json.dumps(payload, ensure_ascii=False, indent=2).replace(token, '[REDACTED]'))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', type=base_url, default=os.environ.get('MARS_MCP_URL', 'http://localhost:4400'))
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('login', help='Authenticate through Discord with explicit browser approval').add_argument('--no-browser', action='store_true')
    commands.add_parser('me')
    commands.add_parser('logout')
    commands.add_parser('tools', help='Discover tools through MCP tools/list')
    call = commands.add_parser('call', help='Invoke MCP tools/call')
    call.add_argument('name')
    call.add_argument('--arguments', default='{}', help='JSON object of tool arguments')
    args = parser.parse_args(argv)
    try:
        if args.command == 'login':
            login(args)
            return 0
        if args.command == 'logout':
            path = credential_path(args.base_url)
            try:
                token = load_credentials(args.base_url)
            except ClientError:
                # Refuse traversing an unsafe credential directory, even for deletion.
                if path.parent.exists():
                    private_directory(path.parent)
                    path.unlink(missing_ok=True)
                print('Local credentials removed; any unrevoked session expires at its original TTL.')
                return 0
            try:
                checked(args.base_url, '/auth/revoke', method='POST', token=token)
            finally:
                path.unlink(missing_ok=True)
            print('Session revoked and local credentials removed.')
            return 0
        token = load_credentials(args.base_url)
        if args.command == 'me':
            result, _ = checked(args.base_url, '/auth/me', token=token)
            emit(result, token)
            return 0
        params = {}
        if args.command == 'call':
            arguments = json.loads(args.arguments)
            if not isinstance(arguments, dict):
                raise ClientError('--arguments must be a JSON object.')
            params = {'name': args.name, 'arguments': arguments}
        result = mcp(args.base_url, token, 'tools/list' if args.command == 'tools' else 'tools/call', params)
        emit(result, token)
        return 1 if 'error' in result or result.get('result', {}).get('isError') else 0
    except (ClientError, OSError):
        # Never print transport/OS exception objects, which may contain credentials.
        exc = sys.exc_info()[1]
        print('mars:', str(exc) if isinstance(exc, ClientError) else 'Local I/O or connection failed.', file=sys.stderr)
        return 1
    except (KeyError, TypeError, ValueError, AttributeError):
        print('mars: Invalid arguments or server response.', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('\nmars: Cancelled.', file=sys.stderr)
        return 130


if __name__ == '__main__':
    sys.exit(main())
