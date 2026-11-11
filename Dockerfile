# The live screen (live/, issue #1) is a small Node service; only the Node binary and its two dependencies ship.
FROM mirror.gcr.io/library/node:22-bookworm-slim AS live
WORKDIR /live
COPY live/package.json live/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM mirror.gcr.io/library/python:3.12-slim
LABEL org.opencontainers.image.source="https://github.com/humanitylabs-org/wizard-recorder"
LABEL org.opencontainers.image.licenses="GPL-3.0-only"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MEETINGS_DATA=/data MIZEL_LIVE_DIR=/live
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home recorder && mkdir -p /data && chown 1000:1000 /data
COPY app/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY app/server.py app/package_routes.py app/wizard_switches.py app/live_screen.py app/audio_playback.py app/agent_delivery.py openapi.json /app/
COPY --from=live /usr/local/bin/node /usr/local/bin/node
COPY --from=live /live/node_modules /live/node_modules
COPY live/package.json live/server.mjs live/provider.js live/agent-router.mjs live/orb-authority.mjs live/orb-events.mjs live/owner-identity.mjs /live/
COPY live/web /live/web
RUN chmod -R a+rX,go-w /app /live
USER 1000:1000
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=2)"]
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
