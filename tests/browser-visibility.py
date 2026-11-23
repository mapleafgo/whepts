import os, sys, threading
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class H(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path != '/':
            if self.path == '/dist/index.js' or self.path.startswith(('/node_modules/eventemitter3/dist/', '/node_modules/nanostores/')):
                if '..' not in self.path and '%' not in self.path and not self.path.endswith('/'):
                    return super().do_GET()
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'''<style>body{margin:0} #spacer{height:3000px} #video{width:320px;height:240px;display:block}</style>
<script type="importmap">{"imports":{"eventemitter3":"/node_modules/eventemitter3/dist/eventemitter3.esm.js","nanostores":"/node_modules/nanostores/index.js"}}</script>
<div id="top">top</div><div id="spacer"></div><video id="video" muted playsinline></video><div id="spacer2" style="height:3000px"></div>''')


srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/google-chrome'), headless=True)
    try:
        page = browser.new_page(viewport={'width': 800, 'height': 600})
        page.add_init_script("globalThis.process={env:{NODE_ENV:'production'}}")
        page.on('console', lambda m: print('console:', m.text))
        page.goto(f'http://127.0.0.1:{srv.server_port}/')
        page.evaluate("""async base => {
          const {default: Whep} = await import('/dist/index.js');
          const video = document.querySelector('#video');
          window.events = [];
          window.player = new Whep({url: base, container: video, ...(new URL(base).pathname.startsWith('/index/api/') ? {iceMode: 'complete'} : {})});
          ['play:success', 'play:failed', 'play:stalled'].forEach(name => player.on(name, payload => events.push([name, Math.round(performance.now()), JSON.stringify(payload).slice(0, 70)])));
          window.mark = label => (window.marks ??= []).push([label, Math.round(performance.now())]);
          player.on('error', e => events.push(['error', e.phase, e.message, e.httpStatus]));
        }""", sys.argv[1])
        # 视频最初在视口外，不应挂载也不应出帧。
        page.wait_for_timeout(3000)
        offscreen = page.evaluate("() => ({paused: document.querySelector('#video').paused, src: Boolean(document.querySelector('#video').srcObject), state: player.state, events: window.events.map(e => e[0])})")
        print('offscreen:', page.evaluate("() => window.events"))
        print('offscreen summary:', offscreen)
        assert offscreen['src'] is False, offscreen
        assert offscreen['state'] == 'running', offscreen
        # 滚动进入视口：应开始播放。
        page.evaluate("() => { mark('scroll-in'); document.querySelector('#video').scrollIntoView({block: 'center'}) }")
        page.wait_for_function("() => { const v = document.querySelector('#video'); return v.srcObject && !v.paused && v.getVideoPlaybackQuality().totalVideoFrames >= 3 }", timeout=20000)
        shown = page.evaluate("() => ({frames: document.querySelector('#video').getVideoPlaybackQuality().totalVideoFrames, ct: document.querySelector('#video').currentTime})")
        print('visible:', shown)
        # 滚出视口：应停止并解绑，但传输仍 running。
        page.evaluate("() => { mark('scroll-out'); document.querySelector('#top').scrollIntoView({block: 'start'}) }")
        page.wait_for_timeout(6500)
        print('timeline:', page.evaluate('() => ({marks: window.marks, events: window.events})'))
        page.wait_for_function("() => document.querySelector('#video').srcObject === null", timeout=8000)
        hidden = page.evaluate("() => ({src: Boolean(document.querySelector('#video').srcObject), state: player.state, events: window.events.map(e => e[0])})")
        print('scrolled away:', hidden)
        assert hidden['state'] == 'running', hidden
        # 再次进入：恢复并继续出帧。
        page.evaluate("() => document.querySelector('#video').scrollIntoView({block: 'center'})")
        page.wait_for_function("() => { const v = document.querySelector('#video'); return v.srcObject && !v.paused && v.getVideoPlaybackQuality().totalVideoFrames >= 5 }", timeout=20000)
        again = page.evaluate("() => ({frames: document.querySelector('#video').getVideoPlaybackQuality().totalVideoFrames, ct: document.querySelector('#video').currentTime, paused: player.paused})")
        print('back in view:', again)
        assert again['paused'] is False
        stalls = page.evaluate("() => window.events.filter(e => e[0] === 'play:stalled')")
        assert stalls == [], stalls
    finally:
        browser.close()