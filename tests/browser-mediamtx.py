import os, sys, threading
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_HEAD(self):
        self.send_error(405)

    def do_GET(self):
        if self.path != '/':
            if self.path == '/dist/index.js' or self.path.startswith(('/node_modules/eventemitter3/dist/', '/node_modules/nanostores/')):
                if '..' not in self.path and '%' not in self.path and not self.path.endswith('/'):
                    return super().do_GET()
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type','text/html')
        self.end_headers()
        self.wfile.write('<script type="importmap">{"imports":{"eventemitter3":"/node_modules/eventemitter3/dist/eventemitter3.esm.js","nanostores":"/node_modules/nanostores/index.js"}}</script><body></body>'.encode())
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/google-chrome'), headless=True)
    try:
        page=browser.new_page()
        page.add_init_script("globalThis.process = { env: { NODE_ENV: 'production' } }")
        page.on('console',lambda m: print('console:',m.text))
        responses = []
        delete_responses = []

        def report_response(response):
            if response.url.startswith(sys.argv[1] + '/'):
                responses.append((response.request.method, response.status))
                print('whep:', *responses[-1])
                if response.request.method == 'DELETE':
                    delete_responses.append((response.url, response.status))

        page.on('response', report_response)
        root=f'http://127.0.0.1:{server.server_port}/'
        page.goto(root)
        page.evaluate('''async base => {
          const {default: Whep} = await import('/dist/index.js');
          const video = document.createElement('video'); video.muted = true; document.body.append(video);
          const nativeFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const response = await nativeFetch(...args);
            if (args[1]?.method === 'POST' && response.status === 201) {
              const loc = response.headers.get('Location');
              console.log('Visible response headers:', Boolean(loc), Boolean(response.headers.get('ETag')));
              window.sessionURL = new URL(loc, response.url).href;
            }
            return response;
          };
          window.diagnostics = [];
          window.player = new Whep({url: base + '/live/whep', container: video, lazyLoad: false});
          window.player.on('diagnostic', d => diagnostics.push(d));
          window.player.on('error', e => console.error(e.phase, e.message, e.httpStatus));
          window.player.on('webrtc:codecs-detected', c => console.log(JSON.stringify(c)));
        }''',sys.argv[1])
        page.wait_for_function("document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames >= 3",timeout=18000)
        print('frames',page.locator('video').evaluate('(v) => v.getVideoPlaybackQuality().totalVideoFrames'))
        first_session = page.evaluate('window.sessionURL')
        page.evaluate("base => { window.firstStream = document.querySelector('video').srcObject; player.updateUrl(base + '/backup/whep') }",sys.argv[1])
        page.wait_for_function("() => { const v = document.querySelector('video'); return v.srcObject && v.srcObject !== window.firstStream && v.videoWidth === 160 && v.currentTime > 0.2 }",timeout=20000)
        print('Switched stream width:',page.locator('video').evaluate('(v) => v.videoWidth'))
        session_url = page.evaluate('window.sessionURL')
        with page.expect_response(lambda r: r.request.method == 'DELETE' and r.url == session_url,timeout=6000) as deleted:
            assert page.evaluate("() => { player.close(); player.close(); return player.state === 'closed' && document.querySelector('video').srcObject === null }")
        status = deleted.value.status
        print('Player DELETE status:', status)
        if not 200 <= status < 300:
            page.wait_for_function("status => diagnostics.some(d => d.operation === 'delete-session' && d.attemptId === 2 && d.state === 'closed' && d.reason === 'http-error' && d.httpStatus === status)", arg=status, timeout=3000)
            print('Close-time DELETE failure diagnostic verified')
        assert page.evaluate('player.state') == 'closed'
        if os.environ.get('WHEPTS_REQUIRE_DELETE_SUCCESS') == '1':
            assert first_session != session_url
            assert sorted(url for url, _ in delete_responses) == sorted([first_session, session_url])
            assert all(200 <= status < 300 for _, status in delete_responses)
        assert responses.count(('OPTIONS', 204)) >= 2, responses
        assert responses.count(('POST', 201)) == 2, responses
        first_post = responses.index(('POST', 201))
        second_post = responses.index(('POST', 201), first_post + 1)
        assert ('PATCH', 204) in responses[first_post:second_post], responses
        assert ('PATCH', 204) in responses[second_post:], responses
    finally:
        browser.close()
