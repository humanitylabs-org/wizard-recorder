FROM python:3.12-slim
LABEL org.opencontainers.image.source="https://github.com/humanitylabs-org/meeting-recorder"
LABEL org.opencontainers.image.licenses="GPL-3.0-only"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MEETINGS_DATA=/data
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home recorder && mkdir -p /data && chown 1000:1000 /data
COPY app/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY app/server.py app/package_routes.py app/audio_playback.py /app/
COPY web/ /web/
USER 1000:1000
WORKDIR /app
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
