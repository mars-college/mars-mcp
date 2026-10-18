"""Focused standard-library helper regressions: python3 tests/helper.test.py."""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('mars_helper', Path(__file__).resolve().parents[1] / 'skills/mars-mcp/scripts/mars.py')
mars = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mars)


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.environment = patch.dict(os.environ, {'XDG_CONFIG_HOME': self.directory.name, 'MARS_MCP_URL': 'http://localhost:4400'})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.origin = 'http://localhost:4400'
        self.token = 'never-print-this-secret'

    def test_private_origin_bound_storage(self):
        mars.save_credentials(self.origin, self.token, 60)
        path = mars.credential_path(self.origin)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(mars.load_credentials(self.origin), self.token)
        with self.assertRaises(mars.ClientError):
            mars.load_credentials('https://example.org')
        data = json.loads(path.read_text())
        data['origin'] = 'https://example.org'
        path.write_text(json.dumps(data))
        with self.assertRaises(mars.ClientError):
            mars.load_credentials(self.origin)

    def test_rejects_public_expired_and_symlink_credentials(self):
        mars.save_credentials(self.origin, self.token, 60)
        path = mars.credential_path(self.origin)
        path.chmod(0o644)
        with self.assertRaises(mars.ClientError):
            mars.load_credentials(self.origin)
        path.chmod(0o600)
        with patch.object(mars.time, 'time', return_value=10**12):
            with self.assertRaises(mars.ClientError):
                mars.load_credentials(self.origin)
        target = path.with_suffix('.target')
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaises(mars.ClientError):
            mars.load_credentials(self.origin)

    def test_origin_policy_and_canonicalization(self):
        self.assertEqual(mars.base_url('HTTPS://Example.org:443/'), 'https://example.org')
        self.assertEqual(mars.base_url('http://[::1]:4400'), 'http://[::1]:4400')
        for origin in ['http://example.org', 'https://user:secret@example.org', 'https://example.org/path', 'https://example.org?x=1', 'http://localhost.evil', 'file:///tmp/test']:
            with self.subTest(origin=origin), self.assertRaises(argparse.ArgumentTypeError):
                mars.base_url(origin)

    def test_redirect_never_forwards_bearer(self):
        received = []

        class Destination(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.headers.get('Authorization'))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{}')

            def log_message(self, *args):
                pass

        destination = ThreadingHTTPServer(('127.0.0.1', 0), Destination)
        target = f'http://127.0.0.1:{destination.server_port}/'

        class Redirect(Destination):
            def do_GET(self):
                self.send_response(302)
                self.send_header('Location', target)
                self.end_headers()

        redirect = ThreadingHTTPServer(('127.0.0.1', 0), Redirect)
        for server in [destination, redirect]:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(thread.join)
            self.addCleanup(server.shutdown)
        with self.assertRaisesRegex(mars.ClientError, 'redirect refused'):
            mars.request(f'http://127.0.0.1:{redirect.server_port}', '/auth/me', token=self.token)
        self.assertEqual(received, [])

    def test_authentication_errors_do_not_echo_server_body(self):
        mars.save_credentials(self.origin, self.token, 60)
        for status, expected in [(401, 'Run login again'), (403, 'Access denied')]:
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(mars, 'request', return_value=(status, {'error': self.token}, {})), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(mars.main(['me']), 1)
            self.assertIn(expected, stderr.getvalue())
            self.assertNotIn(self.token, stdout.getvalue() + stderr.getvalue())

    def test_login_pending_backoff_and_private_success(self):
        flow = {'verification_uri': self.origin + '/auth/verify', 'user_code': 'ABCD-1234', 'device_code': 'device-secret', 'expires_in': 60, 'interval': 1}
        responses = [(200, flow, {}), (400, {'error': 'authorization_pending'}, {}), (400, {'error': 'slow_down'}, {}), (200, {'access_token': self.token, 'token_type': 'Bearer', 'expires_in': 60}, {})]
        stdout = io.StringIO()
        with patch.object(mars, 'request', side_effect=responses), patch.object(mars.time, 'sleep') as sleep, contextlib.redirect_stdout(stdout):
            self.assertEqual(mars.main(['login', '--no-browser']), 0)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 1, 6])
        self.assertEqual(mars.load_credentials(self.origin), self.token)
        self.assertIn('ABCD-1234', stdout.getvalue())
        self.assertNotIn(self.token, stdout.getvalue())
        self.assertNotIn('device-secret', stdout.getvalue())

    def test_tool_error_is_structured_and_secret_redacted(self):
        mars.save_credentials(self.origin, self.token, 60)
        responses = [(200, {'jsonrpc': '2.0', 'id': 1, 'result': {'protocolVersion': '2025-11-25'}}, {}), (202, None, {}), (200, {'jsonrpc': '2.0', 'id': 2, 'error': {'code': -32602, 'message': self.token}}, {})]
        stdout = io.StringIO()
        with patch.object(mars, 'request', side_effect=responses), contextlib.redirect_stdout(stdout):
            self.assertEqual(mars.main(['call', 'unknown', '--arguments', '{}']), 1)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload['error']['code'], -32602)
        self.assertNotIn(self.token, stdout.getvalue())


if __name__ == '__main__':
    unittest.main()
