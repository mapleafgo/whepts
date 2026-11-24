"""Run with python tests/browser-counter-offer.py against an existing production bundle."""

import os
import queue
import threading
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OFFER = '/whep'
SESSION = '/session'
# 超过 15 秒建连期限，保留少量浏览器调度余量。
DEADLINE_WITH_MARGIN_MS = 18000


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, *_args):
        pass

    def reply(self, status, body=b'', **headers):
        try:
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key.replace('_', '-'), value)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # 超时用例取消 PATCH 后，客户端可能已关闭连接。
            pass

    def do_GET(self):
        if self.path == '/':
            self.reply(200, b'''<!doctype html>
<script type="importmap">{"imports":{"eventemitter3":"/node_modules/eventemitter3/dist/eventemitter3.esm.js","nanostores":"/node_modules/nanostores/index.js"}}</script>
<video muted playsinline></video>''', Content_Type='text/html')
        elif self.path == '/dist/index.js' or (
            self.path.startswith('/node_modules/nanostores/') and self.path.endswith('.js')
        ) or self.path == '/node_modules/eventemitter3/dist/eventemitter3.esm.js':
            if '..' not in self.path and '%' not in self.path:
                return super().do_GET()
            self.reply(404)
        else:
            self.reply(404)

    def do_OPTIONS(self):
        self.reply(204 if self.path == OFFER else 404)

    def do_POST(self):
        if self.path != OFFER or self.headers.get_content_type() != 'application/sdp':
            return self.reply(400)
        self.rfile.read(int(self.headers['Content-Length']))
        content_type = 'application/sdp'
        if self.server.expired:
            content_type += '; valid-until="Thu, 01 Jan 1970 00:00:00 GMT"'
        self.reply(406, self.server.offer.encode(), Location=SESSION, Content_Type=content_type)

    def do_PATCH(self):
        if self.path != SESSION or self.headers.get_content_type() != 'application/sdp':
            return self.reply(400)
        self.server.answers.put(self.rfile.read(int(self.headers['Content-Length'])).decode())
        if self.server.acknowledge.wait(timeout=30):
            self.reply(204)
        else:
            self.reply(504)

    def do_DELETE(self):
        self.reply(204 if self.path == SESSION else 404)


class CounterOfferBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        playwright = sync_playwright().start()
        cls.addClassCleanup(playwright.stop)
        cls.browser = playwright.chromium.launch(
            executable_path=os.environ.get('CHROME_BIN', '/usr/bin/google-chrome'), headless=True
        )
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.addCleanup(self.server.server_close)
        self.server.answers = queue.Queue()
        self.server.acknowledge = threading.Event()
        self.server.expired = False
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.acknowledge.set)
        self.page = self.browser.new_page()
        self.addCleanup(self.page.close)
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.page.add_init_script("globalThis.process = {env: {NODE_ENV: 'production'}}")
        self.page.goto(self.origin)
        self.server.offer = self.page.evaluate('''async () => {
            window.sender = new RTCPeerConnection();
            const canvas = document.createElement('canvas');
            canvas.width = 160;
            canvas.height = 90;
            const context = canvas.getContext('2d');
            let frame = 0;
            setInterval(() => {
                context.fillStyle = frame++ % 2 ? 'red' : 'blue';
                context.fillRect(0, 0, 160, 90);
            }, 50);
            const stream = canvas.captureStream(20);
            sender.addTransceiver(stream.getVideoTracks()[0], {direction: 'sendonly', streams: [stream]});
            await sender.setLocalDescription(await sender.createOffer());
            if (sender.iceGatheringState !== 'complete') {
                await new Promise((resolve, reject) => {
                    const deadline = setTimeout(() => reject(new Error('Sender ICE gathering timed out')), 5000);
                    sender.addEventListener('icegatheringstatechange', () => {
                        if (sender.iceGatheringState !== 'complete') return;
                        clearTimeout(deadline);
                        resolve();
                    });
                });
            }
            return sender.localDescription.sdp;
        }''')

    def start_player(self):
        with self.page.expect_response(
            lambda response: response.request.method == 'POST' and response.url == self.origin + OFFER,
            timeout=10000,
        ) as response:
            self.page.evaluate('''async (url) => {
                const {default: Whep} = await import('/dist/index.js');
                window.video = document.querySelector('video');
                window.errors = [];
                window.player = new Whep({url, container: video, iceMode: 'complete', lazyLoad: false});
                player.on('error', ({type, phase, reason}) => errors.push({type, phase, reason}));
            }''', self.origin + OFFER)
        self.assertEqual(response.value.status, 406)

    def apply_answer(self):
        try:
            answer = self.server.answers.get(timeout=8)
        except queue.Empty:
            self.fail(f"No SDP PATCH received; player errors: {self.page.evaluate('errors')}")
        self.page.evaluate('sdp => sender.setRemoteDescription({type: "answer", sdp})', answer)

    def wait_for_video(self):
        self.page.wait_for_function(
            "sender.connectionState === 'connected' && video.getVideoPlaybackQuality().totalVideoFrames > 3",
            timeout=8000,
        )

    def start_confirmed_playback(self):
        self.server.acknowledge.set()
        with self.page.expect_response(
            lambda response: response.request.method == 'PATCH' and response.url == self.origin + SESSION,
            timeout=10000,
        ) as response:
            self.start_player()
            self.apply_answer()
        self.assertEqual(response.value.status, 204)
        self.wait_for_video()
        self.assertEqual(self.page.evaluate('errors'), [])

    def test_prompt_acknowledgement_plays_and_closes(self):
        self.start_confirmed_playback()
        with self.page.expect_response(
            lambda response: response.request.method == 'DELETE' and response.url == self.origin + SESSION,
            timeout=5000,
        ) as response:
            self.page.evaluate('player.close()')
        self.assertEqual(response.value.status, 204)
        self.assertEqual(self.page.evaluate('player.state'), 'closed')

    def test_unacknowledged_answer_times_out_despite_video(self):
        self.start_player()
        # 发送端应用 answer 并推流，但 HTTP 处理线程继续扣住 204。
        self.apply_answer()
        self.wait_for_video()
        try:
            self.page.wait_for_function('errors.length > 0', timeout=DEADLINE_WITH_MARGIN_MS)
        except PlaywrightTimeoutError:
            self.fail(self.page.evaluate('''() => ({
                state: player.state, peer: sender.connectionState,
                frames: video.getVideoPlaybackQuality().totalVideoFrames, errors,
            })'''))
        self.assertEqual(self.page.evaluate('player.state'), 'failed')
        self.assertEqual(self.page.evaluate('errors.map(error => [error.phase, error.reason])'),
                         [['signaling', 'setup-timeout']])

    def test_expired_offer_is_a_signaling_error_without_patch(self):
        self.server.expired = True
        self.start_player()
        self.page.wait_for_function('errors.length > 0', timeout=5000)
        self.assertEqual(self.page.evaluate('player.state'), 'failed')
        self.assertTrue(self.server.answers.empty(), 'An expired offer must not be answered')
        self.assertEqual(self.page.evaluate('errors.map(error => [error.type, error.phase])'),
                         [['SignalError', 'signaling']])

    def test_async_listener_rejection_is_reported_without_blocking_close(self):
        self.start_confirmed_playback()
        observed = self.page.evaluate('''async () => {
            const diagnostics = [];
            const unhandled = [];
            const order = [];
            let finish;
            const pending = new Promise(resolve => { finish = resolve; });
            window.addEventListener('unhandledrejection', event => {
                unhandled.push(event.reason.name);
                event.preventDefault();
            });
            player.on('diagnostic', async () => {
                throw new Error('Private diagnostic listener detail');
            });
            player.on('diagnostic', ({operation, cause}) => diagnostics.push([operation, cause]));
            player.once('close', async () => {
                order.push('async-start');
                await pending;
                order.push('async-end');
                throw new TypeError('Private close listener detail');
            });
            player.on('close', () => order.push('next'));
            player.close();
            order.push(player.state);
            finish();
            await new Promise(resolve => setTimeout(resolve, 100));
            return {diagnostics, unhandled, order};
        }''')
        self.assertEqual(observed, {
            'diagnostics': [['listener-error', 'TypeError']],
            'unhandled': [],
            'order': ['async-start', 'next', 'closed', 'async-end'],
        })

    def test_off_without_context_removes_callbacks_before_real_close(self):
        self.start_confirmed_playback()
        observed = self.page.evaluate('''() => {
            let calls = 0;
            const callback = () => calls++;
            player.on('close', callback);
            player.once('close', callback, {});
            player.off('close', callback);
            player.close();
            return {state: player.state, calls};
        }''')
        self.assertEqual(observed, {'state': 'closed', 'calls': 0})


if __name__ == '__main__':
    unittest.main(verbosity=2)
