"""Recap delivery to the agent this app routes through (wizard-os spec/AGENTS.md section 5, "App → agent binding").

The app never names an agent. The Wizard installer gives it one endpoint and one app-scoped token:
    WIZARD_DELIVERY_URL    e.g. http://<agent service>/wizard/v1/apps/meeting-recorder/deliveries
    WIZARD_DELIVERY_TOKEN  (or WIZARD_DELIVERY_TOKEN_FILE)
and the owner picks the agent in Wizard ("Routes through"). Unset = no delivery (standalone use).

Each finished recap is queued in a small outbox under the app's data volume and sent with a stable
delivery_key, so a retry never duplicates and a bound agent that is down keeps the item queued.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

RETRY_S = 60


def configured() -> tuple[str, str]:
    url = os.environ.get("WIZARD_DELIVERY_URL", "").strip()
    token = os.environ.get("WIZARD_DELIVERY_TOKEN", "").strip()
    token_file = os.environ.get("WIZARD_DELIVERY_TOKEN_FILE", "").strip()
    if not token and token_file:
        try:
            token = Path(token_file).read_text().strip()
        except OSError:
            token = ""
    return (url, token) if url and token else ("", "")


class Outbox:
    def __init__(self, root: Path):
        self.root = root / "agent-outbox"

    def _path(self, key: str) -> Path:
        return self.root / (hashlib.sha256(key.encode()).hexdigest()[:32] + ".json")

    def queue(self, meeting_id: str, title: str, markdown: str, edition: str) -> dict[str, Any] | None:
        """Queue one recap edition. Returns the item, or None when delivery is not configured."""
        if not configured()[0]:
            return None
        key = f"meeting-{meeting_id}-{edition}"
        item = {
            "delivery_key": key, "thread": "meeting-recaps", "title": f"Recording · {title}"[:60],
            "body": markdown, "metadata": {"meeting_id": meeting_id, "edition": edition},
            "state": "pending", "attempts": 0, "last_error": "", "queued_at": time.time(),
        }
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(key)
        if path.exists():
            return json.loads(path.read_text())
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(item))
        tmp.replace(path)
        return item

    def pending(self) -> list[tuple[Path, dict[str, Any]]]:
        out = []
        for path in sorted(self.root.glob("*.json")) if self.root.is_dir() else []:
            try:
                item = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if item.get("state") != "delivered":
                out.append((path, item))
        return out

    def status(self) -> dict[str, Any]:
        items = []
        for path in sorted(self.root.glob("*.json")) if self.root.is_dir() else []:
            try:
                items.append(json.loads(path.read_text()))
            except (OSError, ValueError):
                continue
        waiting = [i for i in items if i.get("state") != "delivered"]
        return {"configured": bool(configured()[0]), "delivered": len(items) - len(waiting), "waiting": len(waiting),
                "last_error": next((i.get("last_error") for i in reversed(waiting) if i.get("last_error")), "")}

    async def flush(self, client: httpx.AsyncClient | None = None) -> int:
        """Send every waiting item once. Returns how many were delivered."""
        url, token = configured()
        if not url:
            return 0
        sent = 0
        own = client is None
        client = client or httpx.AsyncClient(timeout=60)
        try:
            for path, item in self.pending():
                body = {k: item[k] for k in ("delivery_key", "thread", "title", "body", "metadata")}
                item["attempts"] = int(item.get("attempts", 0)) + 1
                try:
                    r = await client.post(url, json=body, headers={"Authorization": f"Bearer {token}"})
                    answer = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
                    if r.status_code == 200 and answer.get("verified") is True:
                        item.update(state="delivered", delivered_at=time.time(), last_error="",
                                    agent=(answer.get("agent") or {}).get("label", ""))
                        sent += 1
                    else:   # e.g. 503 bound_agent_unavailable: keep it, try again later
                        item["last_error"] = f"{r.status_code} {answer.get('error', '')} {answer.get('check', '')}".strip()[:200]
                except httpx.HTTPError as exc:
                    item["last_error"] = f"unreachable: {type(exc).__name__}"
                tmp = path.with_suffix(".tmp")
                tmp.write_text(json.dumps(item))
                tmp.replace(path)
        finally:
            if own:
                await client.aclose()
        return sent
