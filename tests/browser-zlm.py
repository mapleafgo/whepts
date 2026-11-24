import os, sys, threading
from pathlib import Path
from http.client import HTTPConnection
from urllib.parse import urlsplit
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
UPSTREAM = urlsplit(sys.argv[1])
assert UPSTREAM.scheme == 'http' and UPSTREAM.hostname == '127.0.0.1'
BASE = f'http://{UPSTREAM.netloc}'
EXPOSE = '--expose-location' in sys.argv[2:]
HOLD = '--hold-peer-close' in sys.argv[2:]
assert not HOLD or EXPOSE
SESSION = '/index/api/delete_webrtc'


class ExposingProxy(SimpleHTTPRequestHandler):
    def log_request(self, *_args):
        # The session URL carries a deletion credential.
        pass

    def forward(self):
        target = urlsplit(self.path)
        origin = f'http://127.0.0.1:{server.server_port}'
        if self.headers.get('Origin') != origin or target.scheme or target.netloc or target.path not in ('/index/api/whep', SESSION):
            self.send_error(403)
            return
        headers = {key: self.headers[key] for key in ('Origin', 'Content-Type', 'Access-Control-Request-Method', 'Access-Control-Request-Headers') if key in self.headers}
        conn = HTTPConnection(UPSTREAM.hostname, UPSTREAM.port, timeout=8)
        try:
            conn.request(self.command, self.path, self.rfile.read(int(self.headers.get('Content-Length', 0))), headers)
            result = conn.getresponse()
            body = result.read()
            self.send_response(result.status)
            for name, value in result.getheaders():
                if name.lower() in ('content-type', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'):
                    self.send_header(name, value)
                if name.lower() == 'location':
                    location = urlsplit(value)
                    assert location.path == SESSION
                    self.send_header('Location', f'{location.path}?{location.query}')
                    self.send_header('Access-Control-Expose-Headers', 'Location')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        finally:
            conn.close()

    do_OPTIONS = do_POST = do_DELETE = forward


if EXPOSE:
    proxy = ThreadingHTTPServer(('127.0.0.1', 0), ExposingProxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    BASE = f'http://127.0.0.1:{proxy.server_port}'

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/google-chrome'), headless=True)
    try:
        page=browser.new_page()
        page.add_init_script("globalThis.process = { env: { NODE_ENV: 'production' } }")
        page.on('console',lambda m: print('console:',m.text))
        requests = []
        page.on('request', lambda req: requests.append(req.method) if req.url.startswith(BASE + "/") else None)
        responses = []
        raw_locations = []
        deletion_urls = []

        def report_response(r):
            if r.url.startswith(BASE + "/"):
                responses.append((r.request.method, r.status))
                headers = r.all_headers() if r.request.method == 'POST' else {}
                if r.request.method == 'POST':
                    raw_locations.append(bool(headers.get('location')))
                if r.request.method == 'DELETE':
                    deletion_urls.append(r.url)
                print('whep:', r.request.method, r.status, sorted(k for k in headers if k in ('location', 'etag')), headers.get('access-control-expose-headers'))
        page.on('response', report_response)
        root=f'http://127.0.0.1:{server.server_port}/'
        page.goto(root)
        page.evaluate('''async ([base, hold]) => {
          const {default: Whep} = await import('/dist/index.js');
          const video = document.createElement('video'); video.muted = true; document.body.append(video);
          window.visibleLocations = [];
          window.deleteStatuses = [];
          window.videoSamples = [];
          if (hold) {
            const nativeClose = RTCPeerConnection.prototype.close;
            const pending = [];
            RTCPeerConnection.prototype.close = function () {
              if (this.connectionState === 'connected') pending.push(this);
              else nativeClose.call(this);
            };
            window.releasePeerCloses = () => pending.splice(0).forEach(pc => nativeClose.call(pc));
          }
          const nativeGetStats = RTCPeerConnection.prototype.getStats;
          RTCPeerConnection.prototype.getStats = async function (...args) {
            const at = performance.now();
            const reports = await nativeGetStats.apply(this, args);
            const bytes = [...reports.values()]
              .filter(r => r.type === 'inbound-rtp' && r.kind === 'video')
              .reduce((sum, r) => sum + r.bytesReceived, 0);
            if (bytes > 0) videoSamples.push({ at, bytes });
            return reports;
          };
          const nativeFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const response = await nativeFetch(...args);
            if (args[1]?.method === 'DELETE') deleteStatuses.push(response.status);
            if (args[1]?.method === 'POST' && response.status === 201) {
              const loc = response.headers.get('Location');
              console.log('Visible response headers:', Boolean(loc), Boolean(response.headers.get('ETag')));
              window.visibleLocations.push(Boolean(loc));
            }
            if (args[1]?.method === 'POST' && response.status === 404)
              console.log('POST 404 body:', (await response.clone().text()).slice(0, 250));
            return response;
          };
          window.player = new Whep({url: base + '/index/api/whep?app=live&stream=camera', container: video, lazyLoad: false, iceMode: 'complete'});
          window.player.on('error', e => console.error(e.phase, e.message, e.httpStatus));
          window.player.on('webrtc:codecs-detected', c => console.log(JSON.stringify(c)));
        }''',[BASE, HOLD])
        page.wait_for_function("document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames >= 3",timeout=18000)
        print('frames',page.locator('video').evaluate('(v) => v.getVideoPlaybackQuality().totalVideoFrames'))
        paused_at = page.evaluate("""() => {
          player.pause();
          const video = document.querySelector('video');
          if (!player.paused || !video.paused || player.state !== 'running')
            throw new Error('Expected local pause without stopping transport');
          return video.currentTime;
        }""")
        page.evaluate("() => player.resume()")
        page.wait_for_function("pausedAt => !player.paused && !document.querySelector('video').paused && document.querySelector('video').currentTime > pausedAt + 0.2", arg=paused_at, timeout=8000)
        print('Pause and resume verified')
        page.wait_for_function('videoSamples.length >= 2 && videoSamples.at(-1).bytes > videoSamples[0].bytes', timeout=18000)
        samples = page.evaluate('videoSamples.slice(0, 2)')
        interval_ms = samples[1]['at'] - samples[0]['at']
        assert 4000 <= interval_ms <= 7500, samples
        print('Native inbound video samples:', samples, 'interval ms:', interval_ms)
        if os.environ.get('WHEPTS_CHECK_STEADY_CADENCE') == '1':
            page.wait_for_function('videoSamples.some((s, i, a) => i > 0 && s.at - a[0].at >= 35000 && s.at - a[i-1].at >= 8500 && s.at - a[i-1].at <= 12500 && s.bytes > a[i-1].bytes)', timeout=55000)
            samples = page.evaluate('videoSamples')
            print('Native sampling intervals (ms):', [round(b['at'] - a['at'], 1) for a, b in zip(samples, samples[1:])])
        page.evaluate("base => { window.firstStream = document.querySelector('video').srcObject; player.updateUrl(base + '/index/api/whep?app=live&stream=backup') }",BASE)
        page.wait_for_function("() => { const v = document.querySelector('video'); return v.srcObject && v.srcObject !== window.firstStream && v.videoWidth === 160 && v.currentTime > 0.2 }",timeout=18000)
        print('Switched to 160px stream')
        assert page.evaluate("() => { player.close(); return player.state === 'closed' && document.querySelector('video').srcObject === null }")
        if EXPOSE:
            page.wait_for_function('deleteStatuses.length === 2', timeout=6000)
            statuses = page.evaluate('deleteStatuses')
            assert statuses == [200, 200], statuses
            if HOLD:
                page.evaluate('releasePeerCloses()')
            assert requests.count('DELETE') == 2 and 'PATCH' not in requests, requests
            assert len(set(deletion_urls)) == 2
            for session_url in deletion_urls:
                session = urlsplit(session_url)
                assert session.path == SESSION
                conn = HTTPConnection(UPSTREAM.hostname, UPSTREAM.port, timeout=4)
                try:
                    conn.request('DELETE', f'{session.path}?{session.query}')
                    result = conn.getresponse()
                    assert result.status == 404, result.status
                    assert b'not found' in result.read().lower()
                finally:
                    conn.close()
            print('Chrome DELETE statuses:', statuses, '; upstream reported both transports absent on direct recheck')
        else:
            assert requests == ['OPTIONS', 'POST', 'OPTIONS', 'POST'], requests
            assert responses == [('OPTIONS', 200), ('POST', 201)] * 2, responses
        assert raw_locations == [True, True], raw_locations
        assert page.evaluate('visibleLocations') == [EXPOSE, EXPOSE]
    finally:
        browser.close()
