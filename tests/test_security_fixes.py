"""Regression tests for shared-IP lockout and bounded HTTP connections."""

import socket
import threading
import time
import unittest
import app
import test_api


class LoginIsolationTest(test_api.ApiTest):
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def test_unrelated_username_failures_do_not_block_valid_admin(self):
        guest = self.new_client()
        for index in range(10):
            self.assertEqual(
                self.request(
                    'POST',
                    '/api/auth/login',
                    {'username': 'unknown', 'password': 'wrong'},
                    client=guest,
                )[0],
                401,
            )
        self.assertEqual(
            self.request(
                'POST',
                '/api/auth/login',
                {'username': 'UNKNOWN', 'password': 'wrong'},
                client=guest,
            )[0],
            429,
        )
        self.assertEqual(
            self.request(
                'POST',
                '/api/auth/login',
                {'username': 'ADMIN', 'password': 'admin-password-123'},
                client=guest,
            )[0],
            200,
        )

    def test_source_budget_does_not_block_unrelated_valid_login(self):
        source_key = 'source:' + app.hashlib.sha256(b'127.0.0.1').hexdigest()
        with app.connect() as conn:
            conn.execute('INSERT INTO login_attempts VALUES (?,100,?)', (source_key, time.time()))
        self.assertEqual(
            self.request(
                'POST',
                '/api/auth/login',
                {'username': 'unknown', 'password': 'wrong'},
                client=self.new_client(),
            )[0],
            429,
        )
        self.assertEqual(
            self.request(
                'POST',
                '/api/auth/login',
                {'username': 'admin', 'password': 'admin-password-123'},
                client=self.new_client(),
            )[0],
            200,
        )
        for _ in range(10):
            self.assertEqual(
                self.request(
                    'POST',
                    '/api/auth/login',
                    {'username': 'admin', 'password': 'wrong'},
                    client=self.new_client(),
                )[0],
                429,
            )
        self.assertEqual(
            self.request(
                'POST',
                '/api/auth/login',
                {'username': 'ADMIN', 'password': 'admin-password-123'},
                client=self.new_client(),
            )[0],
            429,
        )


class BoundedServerTest(unittest.TestCase):
    def test_worker_limit_absolute_deadline_and_recovery(self):
        class Server(app.BoundedHTTPServer):
            max_workers = 1
            idle_timeout = 2
            request_deadline = 0.3

        class Handler(app.Handler):
            def log_message(self, *args):
                pass

        server = Server(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        sockets = []
        try:
            first = socket.create_connection(server.server_address, timeout=2)
            sockets.append(first)
            first.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\n')
            end = time.monotonic() + 1
            while server.workers._value and time.monotonic() < end:
                time.sleep(0.01)
            second = socket.create_connection(server.server_address, timeout=2)
            sockets.append(second)
            self.assertEqual(second.recv(1), b'')
            self.assertEqual(first.recv(1), b'')
            end = time.monotonic() + 1
            while not server.workers._value and time.monotonic() < end:
                time.sleep(0.01)
            third = socket.create_connection(server.server_address, timeout=2)
            sockets.append(third)
            third.sendall(b'GET / HTTP/1.0\r\n\r\n')
            self.assertIn(b'200 OK', third.recv(100))
        finally:
            for connection in sockets:
                connection.close()
            server.shutdown()
            server.server_close()
            thread.join()

    def test_idle_partial_body_is_closed(self):
        class Server(app.BoundedHTTPServer):
            idle_timeout = 0.1
            request_deadline = 2

        server = Server(('127.0.0.1', 0), app.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with socket.create_connection(server.server_address, timeout=2) as connection:
                connection.sendall(
                    b'POST /api/auth/login HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'
                )
                self.assertEqual(connection.recv(1), b'')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
