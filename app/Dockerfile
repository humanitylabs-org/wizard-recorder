FROM node:22-bookworm-slim AS node
FROM python:3.12-slim-bookworm
LABEL org.opencontainers.image.source="https://github.com/humanitylabs-org/wizard-recorder"
LABEL org.opencontainers.image.licenses="GPL-3.0-only"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MEETINGS_DATA=/data MEETINGS_HOST=127.0.0.1 MEETINGS_PORT=8081 TMPDIR=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini libatomic1 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home recorder && mkdir -p /data && chown 1000:1000 /data
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
COPY app/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY view/package*.json /app/view/
RUN cd /app/view && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY app/*.py /app/
COPY view/*.mjs view/provider.js /app/view/
COPY view/web /app/view/web
USER 1000:1000
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "supervise.py"]
