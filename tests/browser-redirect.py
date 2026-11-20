import os
import threading
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        if self.server.expose_location:
            self.send_header('Access-Control-Expose-Headers', 'Location')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()
    def do_POST(self):
        self.server.auth.append((self.path, self.headers.get('Authorization')))
        self.rfile.read(int(self.headers['Content-Length']))
        if self.path == '/entry':
            self.send_response(307)
            self.send_header('Location', self.server.redirect_target)
            self.end_headers()
        else:
            assert self.path == '/final/whep'
            self.send_response(201)
            self.send_header('Location', 'session')
            self.end_headers()
            self.wfile.write(b'invalid SDP')
    def do_DELETE(self):
        self.server.auth.append((self.path, self.headers.get('Authorization')))
        self.server.delete_paths.append(self.path)
        assert self.path == '/final/session'
        self.send_response(204)
        self.end_headers()
    def do_GET(self):
        if self.path == '/dist/index.js' or self.path.startswith((
            '/node_modules/eventemitter3/dist/', '/node_modules/nanostores/'
        )):
            if '..' not in self.path and '%' not in self.path and not self.path.endswith('/'):
                return super().do_GET()
        if self.path != '/':
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type','text/html')
        self.end_headers()
        self.wfile.write('<script type="importmap">{"imports":{"eventemitter3":"/node_modules/eventemitter3/dist/eventemitter3.esm.js","nanostores":"/node_modules/nanostores/index.js"}}</script><body></body>'.encode())
def run_case(playwright, cross_origin, expose_location=True):
    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as entry, ThreadingHTTPServer(('127.0.0.1', 0), Handler) as remote:
        target = remote if cross_origin else entry
        origin = f'http://127.0.0.1:{entry.server_port}'
        entry.redirect_target = f'http://127.0.0.1:{target.server_port}/final/whep'
        for server in (entry, remote):
            server.delete_paths = []
            server.auth = []
            server.expose_location = expose_location
            threading.Thread(target=server.serve_forever, daemon=True).start()
        browser = playwright.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/google-chrome'), headless=True)
        try:
            page = browser.new_page()
            session_requests = []
            page.on('request', lambda request: session_requests.append((request.method, request.url)) if request.method in ('PATCH', 'DELETE') else None)
            page.add_init_script("globalThis.process = {env:{NODE_ENV:'production'}}")
            page.goto(origin)
            expected_method = 'DELETE' if expose_location else 'POST'
            expected_path = '/final/session' if expose_location else '/final/whep'
            with page.expect_response(lambda r: r.request.method == expected_method and r.url.endswith(expected_path), timeout=10000) as result:
                page.evaluate("async () => {const {default: Whep}=await import('/dist/index.js'); window.player=new Whep({url:location.origin+'/entry',container:document.createElement('video'),lazyLoad:false,token:'fixture-token'}); window.failures=[]; player.on('error', error => failures.push(error.phase))}")
            assert result.value.status == (204 if expose_location else 201)
            assert result.value.url == f'http://127.0.0.1:{target.server_port}{expected_path}'
            if not expose_location:
                assert result.value.header_value('location') == 'session'
            page.wait_for_function("player.state === 'failed'", timeout=3000)
            page.evaluate('() => { player.close(); player.close() }')
            assert page.evaluate('player.state') == 'closed'
            assert page.evaluate('failures') == ['connection']
            expected_requests = [('DELETE', result.value.url)] if expose_location else []
            assert session_requests == expected_requests, session_requests
        finally:
            browser.close()
            for server in (entry, remote):
                server.shutdown()
        assert target.delete_paths == (['/final/session'] if expose_location else [])
        token = 'Bearer fixture-token'
        if cross_origin:
            assert entry.auth == [('/entry', token)]
            assert remote.auth == [('/final/whep', None)] + ([('/final/session', None)] if expose_location else [])
        else:
            assert entry.auth == [(path, token) for path in ['/entry', '/final/whep', '/final/session']]
        print(f'Redirect cleanup and credential scope verified (cross_origin={cross_origin}, expose_location={expose_location})')


with sync_playwright() as p:
    run_case(p, False)
    run_case(p, True)
    run_case(p, True, expose_location=False)
