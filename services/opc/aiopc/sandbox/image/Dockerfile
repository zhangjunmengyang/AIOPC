# AIOPC's sandbox: a small Linux desktop running a real Chromium, streamed over WebRTC.
#
# neko (Apache-2.0) already does the hard parts: X server, window manager, WebRTC
# streaming and a web viewer. AIOPC adds what a one-person company needs from it:
# Chinese fonts, the Chrome Web Store (so password managers and other extensions
# install normally), a DevTools port the AI can reach from outside the container,
# and a profile that keeps every login.
FROM ghcr.io/m1k1o/neko/chromium:latest

# Chinese pages and composers render with the same fonts the person sees elsewhere.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

COPY policies.json /etc/chromium/policies/managed/policies.json
COPY chromium.conf /etc/neko/supervisord/chromium.conf
COPY cdp-bridge.py /opt/aiopc/cdp-bridge.py
