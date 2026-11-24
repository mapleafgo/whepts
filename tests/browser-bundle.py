"""Verify the WHEP POST offer in Chrome against an existing production build."""

import os
import queue
import runpy
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

fixture = runpy.run_path(str(Path(__file__).with_name('browser-counter-offer.py')))


class OfferHandler(fixture['Handler']):
    def do_POST(self):
        if self.path != fixture['OFFER'] or self.headers.get_content_type() != 'application/sdp':
            return self.reply(400)
        offer = self.rfile.read(int(self.headers['Content-Length'])).decode()
        self.server.offers.put(offer)
        self.reply(400)


def assert_max_bundle(offer, candidate_mids):
    session, *sections = offer.split('\r\nm=')
    mids = [next(line[6:] for line in section.splitlines() if line.startswith('a=mid:'))
            for section in sections]
    bundle = next(line.split()[1:] for line in session.splitlines()
                  if line.startswith('a=group:BUNDLE '))
    media = [section.splitlines()[0].split()[:2] for section in sections]
    assert [kind for kind, _ in media] == ['video', 'audio'], media
    assert bundle == mids, (bundle, mids)
    assert candidate_mids == [bundle[0]], (candidate_mids, bundle)


def main():
    with ThreadingHTTPServer(('127.0.0.1', 0), OfferHandler) as server:
        server.offers = queue.Queue()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f'http://127.0.0.1:{server.server_port}'
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    executable_path=os.environ.get('CHROME_BIN', '/usr/bin/google-chrome'),
                    headless=True,
                )
                try:
                    for mode in ('trickle', 'complete'):
                        page = browser.new_page()
                        page.add_init_script("globalThis.process = {env: {NODE_ENV: 'production'}}")
                        page.goto(origin)
                        page.evaluate('''async ({url, iceMode}) => {
                            const {default: Whep} = await import('/dist/index.js');
                            window.candidateMids = new Set();
                            window.player = new Whep({
                                url, iceMode, container: document.querySelector('video'), lazyLoad: false,
                            });
                            player.on("candidate", candidate => {
                                if (candidate.candidate) candidateMids.add(candidate.sdpMid);
                            });
                        }''', {'url': origin + fixture['OFFER'], 'iceMode': mode})
                        offer = server.offers.get(timeout=10)
                        if mode == "trickle":
                            page.wait_for_function("candidateMids.size > 0")
                            candidate_mids = page.evaluate("[...candidateMids]")
                        else:
                            candidate_mids = [section.split("a=mid:")[1].splitlines()[0]
                                              for section in offer.split("\r\nm=")[1:]
                                              if "a=candidate:" in section]
                        assert_max_bundle(offer, candidate_mids)
                        page.evaluate('player.close()')
                        page.close()
                        print(f'{mode}: Chrome WHEP POST uses a single BUNDLE transport')
                finally:
                    browser.close()
        finally:
            server.shutdown()
            thread.join()


if __name__ == '__main__':
    main()
