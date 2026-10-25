"""Mizel.ai recorder: live recorder behavior with portable storage and MCP.

Owner integrations are explicit environment configuration. Fresh installs are empty.
Derived from live recorder e4c46d1 + cf610d3; native chunk/stop contracts retained.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import re
import sqlite3
import subprocess
import time
import uuid
import wave
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response

log = logging.getLogger("meetings")
BKK = ZoneInfo(os.environ.get("MEETINGS_TIMEZONE", "UTC"))
BASE = "/meetings"
HOME = Path.home()
DATA = Path(os.environ.get("MEETINGS_DATA_DIR", os.environ.get("MEETINGS_DATA", "/data")))
WEB = Path(os.environ.get("MEETINGS_WEB_DIR", Path(__file__).resolve().parent.parent / "web"))
STT_URL = os.environ.get("MEETINGS_STT_URL", os.environ.get("TRANSCRIPTION_URL", ""))
LLM_URL = os.environ.get("MEETINGS_LLM_URL", "")
LLM_MODEL = os.environ.get("MEETINGS_LLM_MODEL", "glm-5-3")
LLM_FAST_MODEL = os.environ.get("MEETINGS_LLM_FAST_MODEL", "glm-5-3-flash")
MIZEL_EXPORTS = Path(os.environ.get("MEETINGS_MIZEL_EXPORTS", DATA / "imports/mizel"))
ANARLOG_MEETINGS = Path(os.environ.get("MEETINGS_ANARLOG_DIR", DATA / "imports/anarlog"))
CALENDAR_ACCOUNT = os.environ.get("MEETINGS_CALENDAR_ACCOUNT", "")
CALENDAR_ID = os.environ.get("MEETINGS_CALENDAR_ID", "")
USER_MARK = "\u2063"
TEMPLATES = {
    "general": ["Summary", "Key points", "Decisions", "Action items"],
    "one_on_one": ["Updates", "Blockers", "Feedback", "Action items"],
    "sales": ["Context", "Pain points", "Current solution", "Budget and timing", "Objections", "Next steps"],
}
SOURCE_LABEL = {"me": "Me", "them": "Them", "mixed": "Speaker"}


def _llm_key() -> str:
    return os.environ.get("MEETINGS_LLM_KEY", os.environ.get("TINFOIL_API_KEY", ""))


def now_iso() -> str:
    return datetime.now(BKK).isoformat(timespec="seconds")


def default_recording_title(started_at: str) -> str:
    when = datetime.fromisoformat(started_at).astimezone(BKK)
    day = when.day
    suffix = "th" if 11 <= day % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
    return f"{when.strftime('%B')} {day}{suffix} – {when.hour % 12 or 12}:{when.minute:02d} {'AM' if when.hour < 12 else 'PM'}"


def is_default_recording_title(title: str, started_at: str) -> bool:
    return title == default_recording_title(started_at) or title.startswith(("Untitled", "Recording ·", "New meeting"))


# ---------------------------------------------------------------- storage

SCHEMA = """
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
  calendar_json TEXT, notes TEXT NOT NULL DEFAULT '', notes_rev INTEGER NOT NULL DEFAULT 0,
  enhanced_json TEXT, enhance_state TEXT NOT NULL DEFAULT 'idle', enhance_error TEXT,
  import_key TEXT UNIQUE, import_summary TEXT, deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  meeting_id TEXT NOT NULL, source TEXT NOT NULL, seq INTEGER NOT NULL, start_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL, path TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, error TEXT,
  PRIMARY KEY (meeting_id, source, seq)
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, source TEXT NOT NULL, start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL, text TEXT NOT NULL, ord INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS segments_meeting ON segments(meeting_id, start_ms, ord);
CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY, meeting_id TEXT, question TEXT NOT NULL, answer TEXT, status TEXT NOT NULL,
  error TEXT, cites_json TEXT, created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(meeting_id UNINDEXED, body);
CREATE TABLE IF NOT EXISTS tx_window (
  meeting_id TEXT NOT NULL, source TEXT NOT NULL, cursor_ms INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, error TEXT,
  PRIMARY KEY (meeting_id, source)
);
"""


class Store:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        (root / "audio").mkdir(exist_ok=True)
        os.chmod(root, 0o700)
        self.path = root / "meetings.db"
        with closing(self.conn()) as c:
            c.executescript(SCHEMA)
            cols = {r[1] for r in c.execute("PRAGMA table_info(meetings)")}
            if "tx_mode" not in cols:
                c.execute("ALTER TABLE meetings ADD COLUMN tx_mode TEXT NOT NULL DEFAULT 'chunk'")
            # Stop contract (Wizard OS native recorder + browser): how the recording ended and the last seq
            # per track the client promised, so finalizing waits for every chunk instead of racing them.
            for col, ddl in (("final_seq_json", "TEXT"), ("stop_reason", "TEXT"), ("stop_at", "REAL"),
                             ("last_chunk_at", "REAL")):
                if col not in cols:
                    c.execute(f"ALTER TABLE meetings ADD COLUMN {col} {ddl}")

    def conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        return c


store: Store | None = None


def db() -> sqlite3.Connection:
    assert store is not None
    return store.conn()


def reindex(c: sqlite3.Connection, meeting_id: str) -> None:
    m = c.execute("SELECT title, notes, enhanced_json, import_summary FROM meetings WHERE id=?", (meeting_id,)).fetchone()
    if not m:
        return
    segs = " ".join(r[0] for r in c.execute("SELECT text FROM segments WHERE meeting_id=? ORDER BY start_ms, ord", (meeting_id,)))
    enh = json.loads(m["enhanced_json"])["markdown"] if m["enhanced_json"] else ""
    body = "\n".join([m["title"], m["notes"] or "", enh, m["import_summary"] or "", segs])
    c.execute("DELETE FROM search WHERE meeting_id=?", (meeting_id,))
    c.execute("INSERT INTO search(meeting_id, body) VALUES (?, ?)", (meeting_id, body))


# ---------------------------------------------------------------- imports

TS_LINE = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\]\s*(.*)$")


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end < 0:
        return {}, text
    meta: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip().strip('"')
    return meta, text[end + 4:].lstrip("\n")


def import_mizel(c: sqlite3.Connection) -> int:
    added = 0
    if not MIZEL_EXPORTS.is_dir():
        return 0
    for f in sorted(MIZEL_EXPORTS.glob("*.md")):
        st = f.stat()
        key = f"mizel:{f.name}"
        row = c.execute("SELECT id, updated_at FROM meetings WHERE import_key=?", (key,)).fetchone()
        stamp = str(int(st.st_mtime))
        if row and row["updated_at"] == stamp:
            continue
        meta, body = _parse_frontmatter(f.read_text(errors="replace"))
        segs: list[tuple[int, str]] = []
        for line in body.splitlines():
            m = TS_LINE.match(line.strip())
            if m:
                h, mi, s, t = m.groups()
                segs.append(((int(h) * 3600 + int(mi) * 60 + int(s)) * 1000, t))
        started = meta.get("recorded_at") or now_iso()
        try:
            started_dt = datetime.fromisoformat(started).astimezone(BKK)
        except ValueError:
            started_dt = datetime.now(BKK)
        title = f"Recording · {started_dt:%a %d %b %H:%M}"
        duration = (segs[-1][0] + 5000) if segs else 0
        mid = row["id"] if row else "mz_" + hashlib.sha1(key.encode()).hexdigest()[:12]
        if row:
            c.execute("DELETE FROM segments WHERE meeting_id=?", (mid,))
            c.execute("DELETE FROM tx_window WHERE meeting_id=?", (mid,))
            c.execute("UPDATE meetings SET duration_ms=?, updated_at=? WHERE id=?", (duration, stamp, mid))
        else:
            c.execute(
                "INSERT INTO meetings(id,title,source,status,started_at,duration_ms,import_key,created_at,updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (mid, title, "mizel", "ready", started_dt.isoformat(timespec="seconds"), duration, key, now_iso(), stamp),
            )
            added += 1
        c.executemany(
            "INSERT INTO segments(id,meeting_id,source,start_ms,end_ms,text,ord) VALUES (?,?,?,?,?,?,?)",
            [(f"{mid}_{i}", mid, "mixed", ms, ms + 5000, t, i) for i, (ms, t) in enumerate(segs)],
        )
        reindex(c, mid)
    return added


def import_anarlog(c: sqlite3.Connection) -> int:
    added = 0
    if not ANARLOG_MEETINGS.is_dir():
        return 0
    for f in sorted(ANARLOG_MEETINGS.glob("*.md")):
        key = f"anarlog:{f.name}"
        stamp = str(int(f.stat().st_mtime))
        row = c.execute("SELECT id, updated_at FROM meetings WHERE import_key=?", (key,)).fetchone()
        if row and row["updated_at"] == stamp:
            continue
        meta, body = _parse_frontmatter(f.read_text(errors="replace"))
        title_m = re.search(r"^# (.+)$", body, re.M)
        title = title_m.group(1).strip() if title_m else "Anarlog meeting"
        try:
            started = datetime.fromisoformat(meta.get("created_at", "").replace("Z", "+00:00")).astimezone(BKK)
        except ValueError:
            started = datetime.now(BKK)
        sections = re.split(r"^## ", body, flags=re.M)
        notes = summary = transcript = ""
        for sec in sections:
            head, _, rest = sec.partition("\n")
            h = head.strip().lower()
            if h.startswith("meeting note"):
                notes = re.sub(r"\n{3,}", "\n\n", rest).strip()
            elif h.startswith("summar"):
                summary = rest.strip()
            elif h.startswith("transcript"):
                transcript = rest.strip()
        segs = []
        for i, line in enumerate(l for l in transcript.splitlines() if l.strip()):
            m = TS_LINE.match(line.strip())
            if m:
                h_, mi, s, t = m.groups()
                ms = (int(h_) * 3600 + int(mi) * 60 + int(s)) * 1000
            else:
                ms, t = i * 5000, line.strip()
            segs.append((ms, t))
        mid = row["id"] if row else "an_" + hashlib.sha1(key.encode()).hexdigest()[:12]
        duration = (segs[-1][0] + 5000) if segs else 0
        if row:
            c.execute("DELETE FROM segments WHERE meeting_id=?", (mid,))
            c.execute("DELETE FROM tx_window WHERE meeting_id=?", (mid,))
            c.execute("UPDATE meetings SET title=?, notes=?, import_summary=?, duration_ms=?, updated_at=? WHERE id=?",
                      (title, notes, summary, duration, stamp, mid))
        else:
            c.execute(
                "INSERT INTO meetings(id,title,source,status,started_at,duration_ms,notes,import_key,import_summary,created_at,updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (mid, title, "anarlog", "ready", started.isoformat(timespec="seconds"), duration, notes, key, summary, now_iso(), stamp),
            )
            added += 1
        c.executemany(
            "INSERT INTO segments(id,meeting_id,source,start_ms,end_ms,text,ord) VALUES (?,?,?,?,?,?,?)",
            [(f"{mid}_{i}", mid, "mixed", ms, ms + 5000, t, i) for i, (ms, t) in enumerate(segs)],
        )
        reindex(c, mid)
    return added


def run_imports() -> None:
    with closing(db()) as c:
        a = import_mizel(c)
        b = import_anarlog(c)
    if a or b:
        log.info("imported mizel=%s anarlog=%s", a, b)


# ---------------------------------------------------------------- calendar

_cal_cache: dict[str, Any] = {"at": 0.0, "events": []}


def normalize_calendar_events(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep timed and date-only events; Google all-day ends are exclusive."""
    events, seen = [], set()
    for e in raw:
        if e.get("status") == "cancelled" or any(
            a.get("self") and a.get("responseStatus") == "declined" for a in e.get("attendees", [])
        ):
            continue
        start, end = e.get("start") or {}, e.get("end") or {}
        all_day = "date" in start and "dateTime" not in start
        s = start.get("date") if all_day else start.get("dateTime")
        en = end.get("date") if all_day else end.get("dateTime")
        if not s or not en:
            continue
        def instant(value):
            d = datetime.fromisoformat(value)
            return (d.replace(tzinfo=BKK) if d.tzinfo is None else d.astimezone(BKK)).isoformat(timespec="seconds")
        s, en = instant(s), instant(en)
        title = e.get("summary") or "(No title)"
        keys = {("uid", e.get("iCalUID") or e.get("id"), s), ("title", title.strip().lower(), s)}
        if keys & seen:
            continue
        seen |= keys
        meet = e.get("hangoutLink") or ""
        if not meet:
            meet = next((ep.get("uri", "") for ep in (e.get("conferenceData") or {}).get("entryPoints", [])
                         if ep.get("entryPointType") == "video"), "")
        if not meet:
            m = re.search(r"https://[\w.-]*(zoom\.us|meet\.google\.com|teams\.microsoft\.com)/\S+",
                          (e.get("location") or "") + " " + (e.get("description") or ""))
            meet = m.group(0) if m else ""
        events.append({"id": e.get("id"), "title": title, "start": s, "end": en,
                       "allDay": all_day, "calendar_id": e.get("CalendarID") or CALENDAR_ID or "primary",
                       "attendees": [a["email"] for a in e.get("attendees", []) if a.get("email") and not a.get("self")],
                       "meet_url": meet})
    events.sort(key=lambda e: e["start"])
    return events


def fetch_calendar() -> list[dict[str, Any]]:
    if not CALENDAR_ACCOUNT:
        return []
    if time.time() - _cal_cache["at"] < 120:
        return _cal_cache["events"]
    start = datetime.now(BKK).replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=8)
    script = (
        '. "$HOME/.config/gogcli/keyring.env"; export GOG_KEYRING_BACKEND GOG_KEYRING_PASSWORD; '
        'exec "$HOME/.local/bin/gog" --readonly --no-input -a "$ACCOUNT" calendar events '
        '${CAL:+"$CAL"} ${CAL_ALL:+--all} --from "$FROM" --to "$TO" --max 250 --sort start --all-pages --json'
    )
    env = dict(os.environ, ACCOUNT=CALENDAR_ACCOUNT, CAL=CALENDAR_ID,
               CAL_ALL="" if CALENDAR_ID else "1", FROM=start.isoformat(), TO=end.isoformat())
    try:
        out = subprocess.run(["/bin/bash", "-c", script], capture_output=True, text=True, env=env, timeout=60)
        if out.returncode:
            raise RuntimeError("Google Calendar read failed")
        events = normalize_calendar_events(json.loads(out.stdout or "{}").get("events", []))
    except Exception as exc:  # noqa: BLE001
        log.warning("calendar read error: %s", exc)
        if _cal_cache["at"]:
            return _cal_cache["events"]
        raise HTTPException(status_code=503, detail="Google Calendar is unavailable") from exc
    _cal_cache.update(at=time.time(), events=events)
    return events


# ---------------------------------------------------------------- serialization

def meeting_summary(row: sqlite3.Row) -> dict[str, Any]:
    enh = json.loads(row["enhanced_json"]) if row["enhanced_json"] else None
    preview_src = (enh or {}).get("markdown") or row["import_summary"] or row["notes"] or ""
    preview_src = re.sub(r"^\s*# .*$", "", preview_src, count=1, flags=re.M)
    preview = re.sub(r"\[E\d+\]|[#*\[\]_`>\u2063]", " ", preview_src)
    preview = re.sub(r"\s+", " ", preview).strip()[:160]
    return {
        "id": row["id"], "title": row["title"], "source": row["source"], "status": row["status"],
        "started_at": row["started_at"], "duration_ms": row["duration_ms"],
        "calendar_event": json.loads(row["calendar_json"]) if row["calendar_json"] else None,
        "has_notes": bool((row["notes"] or "").strip()), "enhanced": bool(enh), "preview": preview,
    }


def meeting_detail(c: sqlite3.Connection, mid: str) -> dict[str, Any]:
    row = c.execute("SELECT * FROM meetings WHERE id=? AND deleted=0", (mid,)).fetchone()
    if not row:
        raise HTTPException(404, "meeting not found")
    d = meeting_summary(row)
    segs = [dict(r) for r in c.execute(
        "SELECT id, source, start_ms, end_ms, text FROM segments WHERE meeting_id=? ORDER BY start_ms, ord", (mid,))]
    enh = json.loads(row["enhanced_json"]) if row["enhanced_json"] else None
    if enh is None and row["import_summary"]:
        enh = {"template": "imported", "markdown": row["import_summary"], "created_at": row["created_at"],
               "model": row["source"], "evidence": []}
    pending = c.execute("SELECT COUNT(*) FROM chunks WHERE meeting_id=? AND state IN ('pending','running')", (mid,)).fetchone()[0]
    tracks = [{"source": r[0], "chunks": r[1]} for r in c.execute(
        "SELECT source, COUNT(*) FROM chunks WHERE meeting_id=? GROUP BY source", (mid,))]
    asks = [{"id": r["id"], "question": r["question"], "answer": r["answer"], "created_at": r["created_at"],
             "status": r["status"]} for r in c.execute(
        "SELECT * FROM asks WHERE meeting_id=? ORDER BY created_at", (mid,))]
    d.update(notes=row["notes"], notes_rev=row["notes_rev"], segments=segs, enhanced=enh, asks=asks,
             jobs={"enhance": row["enhance_state"], "transcribe_pending": pending,
                   "enhance_error": row["enhance_error"]},
             audio={"tracks": tracks})
    return d


# ---------------------------------------------------------------- LLM

async def llm(messages: list[dict[str, str]], *, model: str | None = None, max_tokens: int = 3000,
              timeout: float = 180) -> str:
    """Call the private LLM. Reasoning models can spend the whole budget thinking and return
    empty content (finish_reason=length); retry once with a larger budget and low effort,
    and raise rather than ever returning an empty answer."""
    budget = max_tokens + 6000
    for attempt in range(2):
        async with httpx.AsyncClient(timeout=timeout + 60 * attempt) as client:
            r = await client.post(LLM_URL, headers={"Authorization": f"Bearer {_llm_key()}"}, json={
                "model": model or LLM_MODEL, "messages": messages, "max_tokens": budget, "temperature": 0.2,
                "reasoning_effort": "low",
            })
            r.raise_for_status()
            data = r.json()
        ch = data["choices"][0]
        text = re.sub(r"<think>.*?</think>", "", ch["message"].get("content") or "", flags=re.S).strip()
        if text:
            return text
        log.warning("llm returned empty content (finish=%s, usage=%s); retrying", ch.get("finish_reason"), data.get("usage"))
        budget *= 2
    raise RuntimeError("the private model returned no answer (it ran out of thinking budget); try again")


def fmt_ms(ms: int) -> str:
    s = ms // 1000
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def transcript_block(segs: list[dict[str, Any]], limit_chars: int = 120_000) -> tuple[str, dict[str, dict[str, Any]]]:
    """Group consecutive same-source segments into numbered evidence lines E1..En."""
    lines: list[str] = []
    refs: dict[str, dict[str, Any]] = {}
    group: list[dict[str, Any]] = []

    def flush() -> None:
        if not group:
            return
        n = f"E{len(refs) + 1}"
        text = " ".join(g["text"].strip() for g in group if g["text"].strip())
        if text:
            refs[n] = {"segment_id": group[0]["id"], "start_ms": group[0]["start_ms"], "text": text}
            lines.append(f"[{n}] {fmt_ms(group[0]['start_ms'])} {SOURCE_LABEL.get(group[0]['source'], 'Speaker')}: {text}")
        group.clear()

    for s in segs:
        if group and (s["source"] != group[0]["source"] or len(group) >= 6):
            flush()
        group.append(s)
    flush()
    out = "\n".join(lines)
    if len(out) > limit_chars:
        head, tail = out[: limit_chars // 2], out[-limit_chars // 2:]
        out = head + "\n[... middle of transcript omitted for length ...]\n" + tail
    return out, refs


def owner_identity_prompt() -> str:
    """Track labels identify microphones, not diarized people; never infer the owner."""
    owner = os.environ.get("MEETINGS_OWNER_NAME", "").strip() or "the device owner"
    return (
        f"Recording owner: {owner}. This recording was captured on {owner}'s own device; "
        f"{owner} is the recorder and the owner of these notes. Lines labelled Me come from {owner}'s microphone. "
        "In person, one microphone picks up everyone in the room, so other people's speech can also appear under Me. "
        "Infer individual speakers from content, names, self-introductions and who is addressed, not track labels alone. "
        f"Refer to {owner} by name (or 'the device owner' if unnamed), never as Me in titles. "
        f"Never describe the recording as belonging to anyone else or assign {owner}'s identity to another participant. "
        f"A sentence like 'I am recording with X' (including 'I am doing an SS recording with X') means {owner} "
        f"is recording and X is the other participant. When naming participants in a title, use '{owner} & X: topic', "
        "not 'X recording'. Existing generated titles or notes may misattribute speakers; they are not identity evidence. "
        "Them is the other audio track; Speaker is unlabelled audio. Do not invent an unnamed participant's name."
    )


ENHANCE_SYSTEM = """You turn a meeting transcript plus the user's own rough notes into excellent meeting notes, Granola-style.
Rules:
- Output Markdown only. Start with a one-line '# ' title that names what the meeting was actually about.
- Use exactly these '## ' sections, in order, omitting any that would be empty: {sections}.
- The user's notes are the skeleton. Every non-empty line of the user's notes must appear VERBATIM somewhere in your output, as its own line or bullet, placed in the most relevant section; expand beneath it with indented sub-bullets from the transcript.
- Ground every factual bullet in the transcript and cite it with evidence refs like [E3] (one or two per bullet, using the bracketed line numbers given). Never invent names, numbers, dates or commitments.
- Action items: '- [ ] Owner — task (due if stated) [En]'. Use the recording owner's name for their own commitments.
- Be concise and specific; prefer concrete nouns and numbers over generalities. No preamble, no closing remarks.
{owner_identity}"""


async def run_enhance(mid: str, template: str) -> None:
    with closing(db()) as c:
        d = meeting_detail(c, mid)
    try:
        tx, refs = transcript_block(d["segments"])
        notes = (d["notes"] or "").strip()
        if not tx and not notes:
            raise RuntimeError("nothing to enhance yet: no transcript and no notes")
        sections = ", ".join(TEMPLATES.get(template, TEMPLATES["general"]))
        user = (f"Meeting title: {d['title']}\nDate: {d['started_at']}\n"
                + (f"Calendar attendees: {', '.join(d['calendar_event']['attendees'])}\n" if d.get("calendar_event") else "")
                + f"\n<user_notes>\n{notes or '(none)'}\n</user_notes>\n\n<transcript>\n{tx or '(no transcript)'}\n</transcript>")
        md = await llm([{"role": "system", "content": ENHANCE_SYSTEM.format(sections=sections, owner_identity=owner_identity_prompt())},
                        {"role": "user", "content": user}], max_tokens=4000)
        # Mark the user's own lines so the view can style them as "yours".
        own = {re.sub(r"^[-*#\s]+", "", l).strip().lower() for l in notes.splitlines() if l.strip()}
        out_lines = []
        for line in md.splitlines():
            core = re.sub(r"^[\s>*#-]+|\s*\[E\d+\](\s*\[E\d+\])*\s*$", "", line).strip().lower()
            out_lines.append((USER_MARK + line) if core and core in own else line)
        md = "\n".join(out_lines)
        used = sorted({int(n) for n in re.findall(r"\[E(\d+)\]", md)})
        evidence = [{"ref": f"E{n}", "segment_id": refs[f"E{n}"]["segment_id"], "start_ms": refs[f"E{n}"]["start_ms"],
                     "quote": refs[f"E{n}"]["text"][:400]} for n in used if f"E{n}" in refs]
        title_m = re.match(r"^\s*# (.+)$", md.replace(USER_MARK, ""), re.M)
        enhanced = {"template": template, "markdown": md, "created_at": now_iso(), "model": LLM_MODEL, "evidence": evidence}
        with closing(db()) as c:
            row = c.execute("SELECT title, source, calendar_json, started_at FROM meetings WHERE id=?", (mid,)).fetchone()
            new_title = row["title"]
            if title_m and (is_default_recording_title(row["title"], row["started_at"]) and not row["calendar_json"]):
                new_title = title_m.group(1).strip()[:120]
            c.execute("UPDATE meetings SET enhanced_json=?, enhance_state='idle', enhance_error=NULL, title=?, updated_at=? WHERE id=?",
                      (json.dumps(enhanced), new_title, now_iso(), mid))
            reindex(c, mid)
    except Exception as exc:  # noqa: BLE001
        log.exception("enhance failed for %s", mid)
        with closing(db()) as c:
            c.execute("UPDATE meetings SET enhance_state='error', enhance_error=? WHERE id=?", (str(exc)[:300], mid))


ASK_SYSTEM = """You answer questions about the user's meetings using ONLY the provided material.
Cite evidence like [E4] for transcript lines (single-meeting mode) or [M2] for meetings (cross-meeting mode).
If the material does not contain the answer, say so plainly. Be direct and concise; Markdown allowed. No preamble."""


async def run_ask(ask_id: str, mid: str, question: str) -> None:
    with closing(db()) as c:
        d = meeting_detail(c, mid)
    try:
        tx, _ = transcript_block(d["segments"], limit_chars=100_000)
        enh = (d["enhanced"] or {}).get("markdown", "").replace(USER_MARK, "")
        user = (f"Meeting: {d['title']} ({d['started_at']})\n\n<notes>\n{d['notes'] or '(none)'}\n</notes>\n\n"
                f"<enhanced_notes>\n{enh or '(none)'}\n</enhanced_notes>\n\n<transcript>\n{tx or '(none)'}\n</transcript>\n\n"
                f"Question: {question}")
        answer = await llm([{"role": "system", "content": ASK_SYSTEM + "\n" + owner_identity_prompt()}, {"role": "user", "content": user}], max_tokens=1500)
        with closing(db()) as c:
            c.execute("UPDATE asks SET answer=?, status='done' WHERE id=?", (answer, ask_id))
    except Exception as exc:  # noqa: BLE001
        log.exception("ask failed")
        with closing(db()) as c:
            c.execute("UPDATE asks SET status='error', error=?, answer=? WHERE id=?",
                      (str(exc)[:300], "Sorry — the private model did not answer. Try again.", ask_id))


def _fts_query(q: str) -> str:
    words = [w for w in re.findall(r"[\w']+", q.lower()) if len(w) > 2]
    stop = {"the", "and", "what", "did", "was", "were", "about", "with", "for", "who", "when", "how", "that", "this",
            "have", "has", "our", "his", "her", "they", "them", "from", "any", "all", "say", "said", "meeting", "meetings"}
    words = [w for w in words if w not in stop][:8]
    return " OR ".join(f'"{w}"' for w in words)


async def ask_all(question: str) -> dict[str, Any]:
    with closing(db()) as c:
        q = _fts_query(question)
        rows = []
        if q:
            rows = list(c.execute(
                "SELECT m.* FROM search s JOIN meetings m ON m.id=s.meeting_id WHERE search MATCH ? AND m.deleted=0"
                " ORDER BY bm25(search) LIMIT 5", (q,)))
        if len(rows) < 3:
            seen = {r["id"] for r in rows}
            rows += [r for r in c.execute("SELECT * FROM meetings WHERE deleted=0 ORDER BY started_at DESC LIMIT 6")
                     if r["id"] not in seen][: 5 - len(rows)]
        blocks, cites = [], []
        for i, r in enumerate(rows, 1):
            d = meeting_detail(c, r["id"])
            enh = (d["enhanced"] or {}).get("markdown", "").replace(USER_MARK, "")
            tx, _ = transcript_block(d["segments"], limit_chars=6_000)
            blocks.append(f"[M{i}] {d['title']} — {d['started_at']}\nNotes:\n{(enh or d['notes'] or '(none)')[:4000]}\n"
                          f"Transcript excerpt:\n{tx[:6000]}")
            cites.append({"ref": f"M{i}", "id": d["id"], "title": d["title"], "started_at": d["started_at"]})
    answer = await llm([{"role": "system", "content": ASK_SYSTEM + "\n" + owner_identity_prompt()},
                        {"role": "user", "content": "\n\n".join(blocks) + f"\n\nQuestion: {question}"}], max_tokens=1500)
    used = set(re.findall(r"\[(M\d+)\]", answer))
    return {"answer": answer, "meetings": [c_ for c_ in cites if c_["ref"] in used] or cites[:3]}


# ---------------------------------------------------------------- transcription worker

def _wav_info(data: bytes) -> tuple[int, int]:
    with wave.open(io.BytesIO(data)) as w:
        return w.getframerate(), int(w.getnframes() * 1000 / max(1, w.getframerate()))


def _split_wav(data: bytes) -> list[bytes]:
    with wave.open(io.BytesIO(data)) as w:
        params, frames = w.getparams(), w.readframes(w.getnframes())
    half = (len(frames) // 2 // (params.sampwidth * params.nchannels)) * params.sampwidth * params.nchannels
    out = []
    for part in (frames[:half], frames[half:]):
        b = io.BytesIO()
        with wave.open(b, "wb") as w:
            w.setparams(params)
            w.writeframes(part)
        out.append(b.getvalue())
    return out


class NoSpeech(Exception):
    pass


async def stt(client: httpx.AsyncClient, data: bytes, depth: int = 0, prompt: str = "") -> str:
    try:
        r = await client.post(STT_URL, files={"file": ("chunk.wav", data, "audio/wav")},
                              data={"mode": "meeting", **({"prompt": prompt} if prompt else {})})
        if r.status_code == 422:
            return ""
        if r.status_code == 502 and "no transcript" in r.text:
            return ""
        r.raise_for_status()
        text = (r.json().get("text") or "").strip()
        if re.search(r"(?i)^(i'?m sorry|i cannot|as an ai|i can'?t (help|assist|transcribe))", text):
            raise RuntimeError("assistant_refusal")
        return text
    except Exception:
        if depth >= 2 or len(data) < 16000:
            raise
        a, b = _split_wav(data)
        return " ".join(t for t in [await stt(client, a, depth + 1, prompt), await stt(client, b, depth + 1, prompt)] if t)


# ---------------------------------------------------------------- window transcription
# 5-second pieces cut words in half and give the model too little context (a lone spoken
# question can come back *answered*). Recordings created with transcribe=window keep the
# same 5-second upload chunks for safety, but are transcribed in ~30-second stretches cut
# at the quietest moment, so every sentence reaches the model whole.
WINDOW_TARGET_MS = 30_000      # transcribe once this much audio is waiting…
WINDOW_MIN_CUT_MS = 18_000     # …cutting at the quietest point between 18 s and 30 s
WINDOW_IDLE_S = 12.0           # or when no new chunk has arrived for this long (pause)
WINDOW_PROMPT = ("Verbatim transcript of a recorded conversation. The speaker sometimes addresses an AI "
                 "assistant named Archimedes; transcribe those words exactly and never answer them.")


def _quietest_cut(pcm: bytes, lo_ms: int, hi_ms: int) -> int:
    """Byte offset of the quietest 200 ms frame centre between lo_ms and hi_ms (16 kHz mono s16)."""
    import array
    frame = 3200  # 100 ms
    best, best_e = hi_ms * 32, None
    for start in range(lo_ms * 32, min(hi_ms * 32, len(pcm)) - 2 * frame, frame):
        a = array.array("h"); a.frombytes(pcm[start:start + 2 * frame])
        e = sum(x * x for x in a[::4])
        if best_e is None or e < best_e:
            best_e, best = e, start + frame
    return best - best % 2


def _wav_bytes(pcm: bytes, rate: int = 16000) -> bytes:
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm)
    return b.getvalue()


def _pcm_of(path: str) -> tuple[bytes, int]:
    with wave.open(path) as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise RuntimeError("unexpected chunk format")
        return w.readframes(w.getnframes()), w.getframerate()


async def window_pass(client: httpx.AsyncClient) -> bool:
    """Transcribe at most one ready window. Returns True when it did work."""
    now = time.time()
    with closing(db()) as c:
        groups = list(c.execute(
            "SELECT k.meeting_id, k.source, m.status, MIN(k.seq) AS first_seq, MAX(k.rowid) AS last_row"
            " FROM chunks k JOIN meetings m ON m.id=k.meeting_id"
            " WHERE m.tx_mode='window' AND k.state='pending' GROUP BY k.meeting_id, k.source"))
        for g in groups:
            cur = c.execute("SELECT * FROM tx_window WHERE meeting_id=? AND source=?", (g["meeting_id"], g["source"])).fetchone()
            if cur and cur["next_at"] > now:
                continue
            chunks = list(c.execute(
                "SELECT rowid, * FROM chunks WHERE meeting_id=? AND source=? AND state='pending' ORDER BY seq",
                (g["meeting_id"], g["source"])))
            cursor_ms = cur["cursor_ms"] if cur else 0
            # Only a contiguous run of chunks from the first pending one.
            run = [chunks[0]]
            for k in chunks[1:]:
                if k["seq"] != run[-1]["seq"] + 1:
                    break
                run.append(k)
            pcm = b""; rate = 16000; skip = 0
            for i, k in enumerate(run):
                data, rate = _pcm_of(k["path"])
                if i == 0 and k["start_ms"] < cursor_ms < k["start_ms"] + k["duration_ms"]:
                    skip = (cursor_ms - k["start_ms"]) * rate // 1000 * 2
                    data = data[skip:]
                pcm += data
            if rate != 16000:
                continue
            total_ms = len(pcm) // 32
            last_arrival = max(os.path.getmtime(k["path"]) for k in run)
            flushing = g["status"] != "recording" or (now - last_arrival) > WINDOW_IDLE_S or len(run) < len(chunks)
            if total_ms < WINDOW_TARGET_MS and not flushing:
                continue
            if total_ms <= WINDOW_TARGET_MS + 2000 and flushing:
                cut = len(pcm)
            else:
                cut = _quietest_cut(pcm, WINDOW_MIN_CUT_MS, WINDOW_TARGET_MS)
            start_ms = max(run[0]["start_ms"], cursor_ms)
            job = dict(meeting_id=g["meeting_id"], source=g["source"], run=[dict(k) for k in run],
                       start_ms=start_ms, cut_ms=cut // 32, pcm=pcm[:cut], first_seq=run[0]["seq"])
            break
        else:
            return False
    try:
        text = await stt(client, _wav_bytes(job["pcm"]), prompt=WINDOW_PROMPT) if len(job["pcm"]) > 9600 else ""
    except Exception as exc:  # noqa: BLE001
        with closing(db()) as c:
            row = c.execute("SELECT attempts FROM tx_window WHERE meeting_id=? AND source=?", (job["meeting_id"], job["source"])).fetchone()
            attempts = (row["attempts"] if row else 0) + 1
            log.warning("window stt failed %s/%s attempt %s: %s", job["meeting_id"], job["source"], attempts, exc)
            if attempts < 6:
                c.execute("INSERT INTO tx_window(meeting_id,source,cursor_ms,attempts,next_at,error) VALUES (?,?,?,?,?,?)"
                          " ON CONFLICT(meeting_id,source) DO UPDATE SET attempts=excluded.attempts, next_at=excluded.next_at, error=excluded.error",
                          (job["meeting_id"], job["source"], job["start_ms"], attempts, time.time() + min(300, 10 * attempts), str(exc)[:200]))
                return True
            text = ""  # give up on this stretch; keep the audio, move on
    end_ms = job["start_ms"] + job["cut_ms"]
    with closing(db()) as c:
        if text:
            c.execute("INSERT OR REPLACE INTO segments(id,meeting_id,source,start_ms,end_ms,text,ord) VALUES (?,?,?,?,?,?,?)",
                      (f"{job['meeting_id']}_{job['source']}_w{job['start_ms']}", job["meeting_id"], job["source"],
                       job["start_ms"], end_ms, text, job["first_seq"]))
        for k in job["run"]:
            if k["start_ms"] + k["duration_ms"] <= end_ms + 5:
                c.execute("UPDATE chunks SET state='done', error=NULL WHERE meeting_id=? AND source=? AND seq=?",
                          (job["meeting_id"], job["source"], k["seq"]))
        c.execute("INSERT INTO tx_window(meeting_id,source,cursor_ms,attempts,next_at,error) VALUES (?,?,?,0,0,NULL)"
                  " ON CONFLICT(meeting_id,source) DO UPDATE SET cursor_ms=excluded.cursor_ms, attempts=0, next_at=0, error=NULL",
                  (job["meeting_id"], job["source"], end_ms))
    return True


async def transcription_worker(stop: asyncio.Event) -> None:
    async with httpx.AsyncClient(timeout=300) as client:
        while not stop.is_set():
            try:
                if await window_pass(client):
                    continue
            except Exception as exc:  # noqa: BLE001
                log.exception("window pass failed: %s", exc)
            with closing(db()) as c:
                job = c.execute(
                    "SELECT k.* FROM chunks k JOIN meetings m ON m.id=k.meeting_id WHERE k.state='pending' AND k.next_at<=?"
                    " AND m.tx_mode<>'window' ORDER BY k.start_ms LIMIT 1", (time.time(),)
                ).fetchone()
                if job:
                    c.execute("UPDATE chunks SET state='running' WHERE meeting_id=? AND source=? AND seq=?",
                              (job["meeting_id"], job["source"], job["seq"]))
            if not job:
                await maybe_finalize()
                try:
                    await asyncio.wait_for(stop.wait(), 1.0)
                except asyncio.TimeoutError:
                    pass
                continue
            key = (job["meeting_id"], job["source"], job["seq"])
            try:
                text = await stt(client, Path(job["path"]).read_bytes())
                with closing(db()) as c:
                    if text:
                        c.execute(
                            "INSERT OR REPLACE INTO segments(id,meeting_id,source,start_ms,end_ms,text,ord) VALUES (?,?,?,?,?,?,?)",
                            (f"{job['meeting_id']}_{job['source']}_{job['seq']}", job["meeting_id"], job["source"],
                             job["start_ms"], job["start_ms"] + job["duration_ms"], text, job["seq"]))
                    c.execute("UPDATE chunks SET state='done', error=NULL WHERE meeting_id=? AND source=? AND seq=?", key)
            except Exception as exc:  # noqa: BLE001
                attempts = job["attempts"] + 1
                state = "failed" if attempts >= 6 else "pending"
                log.warning("stt failed %s attempt %s: %s", key, attempts, exc)
                with closing(db()) as c:
                    c.execute("UPDATE chunks SET state=?, attempts=?, next_at=?, error=? WHERE meeting_id=? AND source=? AND seq=?",
                              (state, attempts, time.time() + min(300, 10 * attempts), str(exc)[:200], *key))


_enhancing: set[str] = set()


FINAL_SEQ_WAIT_S = float(os.environ.get("MEETINGS_FINAL_SEQ_WAIT_S", 600))   # wait this long for promised chunks
STALE_RECORDING_S = float(os.environ.get("MEETINGS_STALE_RECORDING_S", 6 * 3600))  # no chunk this long → finish


def _missing_promised(c: sqlite3.Connection, mid: str, final_seq_json: str | None) -> int:
    """How many chunks the client promised (final_seq per track) have not arrived yet."""
    if not final_seq_json:
        return 0
    try:
        promised = json.loads(final_seq_json) or {}
    except ValueError:
        return 0
    missing = 0
    for source, last in promised.items():
        if source not in ("me", "them") or not isinstance(last, int) or last < 0:
            continue
        have = c.execute("SELECT COUNT(*) FROM chunks WHERE meeting_id=? AND source=? AND seq<=?",
                         (mid, source, last)).fetchone()[0]
        missing += (last + 1) - have
    return max(0, missing)


def finish_stale_recordings(now: float | None = None) -> list[str]:
    """A recording nobody stopped (tab closed, phone died) is finished after STALE_RECORDING_S without a chunk."""
    now = now or time.time()
    done = []
    with closing(db()) as c:
        for r in c.execute("SELECT id, last_chunk_at, created_at FROM meetings WHERE status='recording' AND deleted=0"
                           " AND source='meetings'").fetchall():
            last = r["last_chunk_at"]
            if last is None:
                try:
                    last = datetime.fromisoformat(r["created_at"]).timestamp()
                except ValueError:
                    continue
            if now - last >= STALE_RECORDING_S:
                c.execute("UPDATE meetings SET status='processing', ended_at=?, updated_at=?, stop_reason='stale',"
                          " stop_at=? WHERE id=? AND status='recording'", (now_iso(), now_iso(), now, r["id"]))
                done.append(r["id"])
    for mid in done:
        log.info("finished stale recording %s (no audio for %.0f h)", mid, STALE_RECORDING_S / 3600)
    return done


async def maybe_finalize() -> None:
    with closing(db()) as c:
        rows = list(c.execute(
            "SELECT id, final_seq_json, stop_at FROM meetings m WHERE status='processing' AND NOT EXISTS"
            " (SELECT 1 FROM chunks k WHERE k.meeting_id=m.id AND k.state IN ('pending','running'))"))
        for r in rows:
            missing = _missing_promised(c, r["id"], r["final_seq_json"])
            if missing and (time.time() - (r["stop_at"] or 0)) < FINAL_SEQ_WAIT_S:
                continue  # the client said more audio is on its way; give it time to land
            if missing:
                log.warning("finalizing %s with %s promised chunk(s) missing after %.0f s", r["id"], missing, FINAL_SEQ_WAIT_S)
            c.execute("UPDATE meetings SET status='ready', updated_at=? WHERE id=?", (now_iso(), r["id"]))
            reindex(c, r["id"])
            has = c.execute("SELECT notes<>'' OR EXISTS(SELECT 1 FROM segments WHERE meeting_id=?) FROM meetings WHERE id=?",
                            (r["id"], r["id"])).fetchone()[0]
            if has:
                c.execute("UPDATE meetings SET enhance_state='running' WHERE id=?", (r["id"],))
                start_bg(run_enhance(r["id"], "general"))


_bg: set[asyncio.Task] = set()


def start_bg(coro) -> None:
    t = asyncio.get_event_loop().create_task(coro)
    _bg.add(t)
    t.add_done_callback(_bg.discard)


# ---------------------------------------------------------------- app

app = FastAPI(title="Meetings", docs_url=None, redoc_url=None, openapi_url=None)
_stop = asyncio.Event()


@app.on_event("startup")
async def _startup() -> None:
    global store
    store = Store(DATA)
    with closing(db()) as c:
        c.execute("UPDATE chunks SET state='pending' WHERE state='running'")
        c.execute("UPDATE meetings SET enhance_state='idle' WHERE enhance_state='running'")
    start_bg(transcription_worker(_stop))
    start_bg(_import_loop())


async def _import_loop() -> None:
    await asyncio.to_thread(run_imports)
    await asyncio.to_thread(finish_stale_recordings)
    while not _stop.is_set():
        try:
            await asyncio.wait_for(_stop.wait(), 300)
        except asyncio.TimeoutError:
            await asyncio.to_thread(run_imports)
            await asyncio.to_thread(finish_stale_recordings)


@app.on_event("shutdown")
async def _shutdown() -> None:
    _stop.set()


@app.middleware("http")
async def _guard(request: Request, call_next):
    path = request.url.path
    if path == BASE or path.startswith(BASE + "/"):
        request.scope["path"] = path[len(BASE):] or "/"
    if request.headers.get("host", "").lower() not in ALLOWED_HOSTS:
        return JSONResponse({"error": "host not allowed"}, status_code=403)
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("sec-fetch-site") == "cross-site":
        return JSONResponse({"error": "cross-site write not allowed"}, status_code=403)
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return JSONResponse({"error": "origin not allowed"}, status_code=403)
    resp = await call_next(request)
    resp.headers.setdefault("Cache-Control", "no-store")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    return resp


ALLOWED_ORIGINS = {o for o in os.environ.get(
    "MEETINGS_ALLOWED_ORIGINS", "http://127.0.0.1:8080,http://localhost:8080").split(",") if o}
ALLOWED_HOSTS = {h.lower() for h in os.environ.get(
    "MEETINGS_ALLOWED_HOSTS", "127.0.0.1:8080,localhost:8080").split(",") if h}


def _mid(mid: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,64}", mid):
        raise HTTPException(404, "meeting not found")
    return mid


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/meetings")
async def list_meetings(q: str = "", limit: int = 200):
    if not 1 <= limit <= 200:
        raise HTTPException(400, "limit must be 1..200")
    with closing(db()) as c:
        if q.strip():
            fq = " ".join(f'"{w}"*' for w in re.findall(r"[\w']+", q)[:8])
            rows = list(c.execute(
                "SELECT m.* FROM search s JOIN meetings m ON m.id=s.meeting_id WHERE search MATCH ? AND m.deleted=0"
                " ORDER BY m.started_at DESC LIMIT ?", (fq, limit))) if fq else []
        else:
            rows = list(c.execute("SELECT * FROM meetings WHERE deleted=0 ORDER BY started_at DESC LIMIT ?", (limit,)))
        return {"meetings": [meeting_summary(r) for r in rows]}


@app.get("/api/calendar")
async def calendar():
    events = await asyncio.to_thread(fetch_calendar)
    now = datetime.now(BKK)
    with closing(db()) as c:
        linked = {json.loads(r[1])["id"]: r[0] for r in c.execute(
            "SELECT id, calendar_json FROM meetings WHERE calendar_json IS NOT NULL AND deleted=0")}
    out = []
    for e in events:
        if datetime.fromisoformat(e["end"]) < now:
            continue
        out.append({**e, "meeting_id": linked.get(e["id"])})
    out.sort(key=lambda e: (datetime.fromisoformat(e["start"]) > now, e["start"]))
    return {"events": out, "as_of": now_iso()}


@app.post("/api/meetings")
async def create_meeting(request: Request):
    body = await request.json() if (await request.body()) else {}
    cal = None
    if body.get("calendar_event_id"):
        cal = next((e for e in await asyncio.to_thread(fetch_calendar) if e["id"] == body["calendar_event_id"]), None)
    started = now_iso()
    requested_title = (body.get("title") or (cal or {}).get("title") or "").strip()
    title = (requested_title if requested_title not in ("", "Untitled meeting", "New meeting") else default_recording_title(started))[:160]
    mid = "mt_" + uuid.uuid4().hex[:12]
    tx_mode = "window" if body.get("transcribe") == "window" else "chunk"
    with closing(db()) as c:
        c.execute("INSERT INTO meetings(id,title,source,status,started_at,calendar_json,created_at,updated_at,tx_mode)"
                  " VALUES (?,?,?,?,?,?,?,?,?)",
                  (mid, title, "meetings", "recording", started, json.dumps(cal) if cal else None, started, started, tx_mode))
        reindex(c, mid)
        return meeting_detail(c, mid)


@app.get("/api/meetings/{mid}")
async def get_meeting(mid: str):
    with closing(db()) as c:
        return meeting_detail(c, _mid(mid))


@app.patch("/api/meetings/{mid}")
async def patch_meeting(mid: str, request: Request):
    body = await request.json()
    with closing(db()) as c:
        meeting_detail(c, _mid(mid))
        if isinstance(body.get("title"), str) and body["title"].strip():
            c.execute("UPDATE meetings SET title=?, updated_at=? WHERE id=?", (body["title"].strip()[:160], now_iso(), mid))
            reindex(c, mid)
        return meeting_detail(c, mid)


@app.put("/api/meetings/{mid}/notes")
async def put_notes(mid: str, request: Request):
    body = await request.json()
    notes = str(body.get("notes", ""))[:200_000]
    with closing(db()) as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT notes, notes_rev FROM meetings WHERE id=? AND deleted=0", (_mid(mid),)).fetchone()
        if not row:
            c.execute("ROLLBACK")
            raise HTTPException(404, "meeting not found")
        if int(body.get("base_rev", -1)) != row["notes_rev"]:
            c.execute("ROLLBACK")
            return JSONResponse({"error": "conflict", "notes": row["notes"], "notes_rev": row["notes_rev"]}, status_code=409)
        c.execute("UPDATE meetings SET notes=?, notes_rev=notes_rev+1, updated_at=? WHERE id=?", (notes, now_iso(), mid))
        c.execute("COMMIT")
        reindex(c, mid)
        return {"notes_rev": row["notes_rev"] + 1}


@app.post("/api/meetings/{mid}/chunks")
async def put_chunk(mid: str, request: Request, source: str, seq: int, start_ms: int):
    if source not in ("me", "them"):
        raise HTTPException(400, "source must be me or them")
    if not 0 <= seq <= 100000 or not 0 <= start_ms <= 86400000:
        raise HTTPException(400, "invalid seq or start_ms")
    data = await request.body()
    if len(data) > 8_000_000:
        raise HTTPException(413, "chunk too large")
    if len(data) > 8_000_000 or not data.startswith(b"RIFF"):
        raise HTTPException(400, "expected a WAV chunk")
    try:
        _, dur = _wav_info(data)
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "unreadable WAV") from None
    with closing(db()) as c:
        row = c.execute("SELECT status FROM meetings WHERE id=? AND deleted=0 AND source='meetings'", (_mid(mid),)).fetchone()
        if not row:
            raise HTTPException(404, "meeting not found")
        if c.execute("SELECT 1 FROM chunks WHERE meeting_id=? AND source=? AND seq=?", (mid, source, seq)).fetchone():
            return {"stored": True, "duplicate": True}
        d = store.root / "audio" / mid / source
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{seq:06d}.wav"
        tmp = p.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)
        c.execute("INSERT INTO chunks(meeting_id,source,seq,start_ms,duration_ms,path) VALUES (?,?,?,?,?,?)",
                  (mid, source, seq, start_ms, dur, str(p)))
        c.execute("UPDATE meetings SET duration_ms=MAX(duration_ms, ?), last_chunk_at=? WHERE id=?",
                  (start_ms + dur, time.time(), mid))
        if row["status"] == "ready":  # late chunk after stop
            c.execute("UPDATE meetings SET status='processing' WHERE id=?", (mid,))
    return {"stored": True}


@app.get("/api/meetings/{mid}/segments")
async def get_segments(mid: str, after: str = ""):
    with closing(db()) as c:
        row = c.execute("SELECT status FROM meetings WHERE id=? AND deleted=0", (_mid(mid),)).fetchone()
        if not row:
            raise HTTPException(404, "meeting not found")
        segs = [dict(r) for r in c.execute(
            "SELECT id, source, start_ms, end_ms, text FROM segments WHERE meeting_id=? ORDER BY start_ms, ord", (mid,))]
        if after:
            ids = [s["id"] for s in segs]
            if after in ids:
                segs = segs[ids.index(after) + 1:]
        pending = c.execute("SELECT COUNT(*) FROM chunks WHERE meeting_id=? AND state IN ('pending','running')", (mid,)).fetchone()[0]
        return {"segments": segs, "transcribe_pending": pending, "status": row["status"]}


STOP_REASONS = {"user", "pause_timeout", "process_death", "stale"}


@app.post("/api/meetings/{mid}/stop")
async def stop_meeting(mid: str, request: Request):
    """Optional JSON body {final_seq: {me: N, them: N}, reason}. final_seq is the last chunk seq per track the
    client recorded; the meeting is not finalized until those chunks arrive (or FINAL_SEQ_WAIT_S passes)."""
    body: dict[str, Any] = {}
    raw = await request.body()
    if raw.strip():
        try:
            body = json.loads(raw)
        except ValueError:
            raise HTTPException(400, "body must be JSON") from None
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")
    final_seq = body.get("final_seq")
    if final_seq is not None:
        if not isinstance(final_seq, dict) or any(
                k not in ("me", "them") or not isinstance(v, int) or isinstance(v, bool) or v < -1
                for k, v in final_seq.items()):
            raise HTTPException(400, "final_seq must be {me|them: last seq}")
    reason = body.get("reason") or "user"
    if reason not in STOP_REASONS:
        raise HTTPException(400, f"reason must be one of {sorted(STOP_REASONS)}")
    with closing(db()) as c:
        row = c.execute("SELECT status FROM meetings WHERE id=? AND deleted=0", (_mid(mid),)).fetchone()
        if not row:
            raise HTTPException(404, "meeting not found")
        if row["status"] == "recording":
            c.execute("UPDATE meetings SET status='processing', ended_at=?, updated_at=?, stop_reason=?, stop_at=?,"
                      " final_seq_json=? WHERE id=?",
                      (now_iso(), now_iso(), reason, time.time(), json.dumps(final_seq) if final_seq else None, mid))
        elif final_seq:
            # A retried stop (phone came back online) may carry the promise the first one lacked.
            c.execute("UPDATE meetings SET final_seq_json=COALESCE(final_seq_json, ?) WHERE id=?",
                      (json.dumps(final_seq), mid))
        return meeting_detail(c, mid)


def _stitched_pcm(rows: list[tuple[str, int, str]]) -> tuple[bytes, int]:
    """Chunks (source, start_ms, path) laid out on media time, gaps filled with silence, tracks mixed."""
    import numpy as np
    tracks: dict[str, np.ndarray] = {}
    for source, start_ms, path in rows:
        try:
            data, rate = _pcm_of(path)
        except Exception:  # noqa: BLE001 — a damaged chunk becomes silence, not a failed player
            continue
        if rate != 16000 or not data:
            continue
        a = np.frombuffer(data[: len(data) // 2 * 2], dtype="<i2")
        off = max(0, start_ms) * 16
        buf = tracks.get(source)
        need = off + len(a)
        if buf is None:
            buf = np.zeros(need, dtype=np.int32)
        elif len(buf) < need:
            buf = np.concatenate([buf, np.zeros(need - len(buf), dtype=np.int32)])
        buf[off:need] = a
        tracks[source] = buf
    if not tracks:
        return b"", 16000
    n = max(len(b) for b in tracks.values())
    mix = np.zeros(n, dtype=np.int32)
    for b in tracks.values():
        mix[: len(b)] += b
    return np.clip(mix, -32768, 32767).astype("<i2").tobytes(), 16000


_audio_cache: dict[str, tuple[str, bytes]] = {}


@app.get("/api/meetings/{mid}/audio.wav")
async def meeting_audio(mid: str, request: Request):
    """The whole recording as one WAV on media time (paused stretches are not in it), with Range support so
    the player can seek. Timestamps in segments, notes and the live outline all point into this file."""
    with closing(db()) as c:
        row = c.execute("SELECT source, status FROM meetings WHERE id=? AND deleted=0", (_mid(mid),)).fetchone()
        if not row:
            raise HTTPException(404, "meeting not found")
        sig = c.execute("SELECT COUNT(*), COALESCE(MAX(seq),-1), COALESCE(SUM(duration_ms),0) FROM chunks WHERE meeting_id=?",
                        (mid,)).fetchone()
        if not sig[0]:
            raise HTTPException(404, "no audio for this meeting")
        key = f"{sig[0]}:{sig[1]}:{sig[2]}"
        hit = _audio_cache.get(mid)
        if hit and hit[0] == key:
            wav = hit[1]
        else:
            rows = [(r[0], r[1], r[2]) for r in c.execute(
                "SELECT source, start_ms, path FROM chunks WHERE meeting_id=? ORDER BY start_ms, seq", (mid,))]
            pcm, rate = await asyncio.to_thread(_stitched_pcm, rows)
            wav = _wav_bytes(pcm, rate)
            if row["status"] == "ready":
                if len(_audio_cache) > 6:
                    _audio_cache.pop(next(iter(_audio_cache)))
                _audio_cache[mid] = (key, wav)
    total = len(wav)
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=60"}
    rng = request.headers.get("range", "")
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
    if m and (m.group(1) or m.group(2)):
        if m.group(1):
            start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else total - 1
        else:
            start = max(0, total - int(m.group(2))); end = total - 1
        end = min(end, total - 1)
        if start > end or start >= total:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{total}"})
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
        return Response(wav[start:end + 1], status_code=206, media_type="audio/wav", headers=headers)
    return Response(wav, media_type="audio/wav", headers=headers)


@app.post("/api/meetings/{mid}/enhance")
async def enhance(mid: str, request: Request):
    body = await request.json() if (await request.body()) else {}
    template = body.get("template") if body.get("template") in TEMPLATES else "general"
    with closing(db()) as c:
        meeting_detail(c, _mid(mid))
        cur = c.execute("UPDATE meetings SET enhance_state='running', enhance_error=NULL WHERE id=? AND COALESCE(enhance_state,'idle')<>'running'", (mid,))
    if cur.rowcount:
        start_bg(run_enhance(mid, template))
    return {"job": "running"}


@app.post("/api/meetings/{mid}/ask")
async def ask_meeting(mid: str, request: Request):
    if not LLM_URL:
        raise HTTPException(503, "Notes provider is not configured")
    body = await request.json()
    q = str(body.get("question", "")).strip()[:2000]
    if not q:
        raise HTTPException(400, "question required")
    ask_id = "q_" + uuid.uuid4().hex[:10]
    with closing(db()) as c:
        meeting_detail(c, _mid(mid))
        c.execute("INSERT INTO asks(id,meeting_id,question,status,created_at) VALUES (?,?,?,?,?)", (ask_id, mid, q, "pending", now_iso()))
    start_bg(run_ask(ask_id, mid, q))
    return {"ask": {"id": ask_id, "question": q, "answer": None, "status": "pending", "created_at": now_iso()}}


@app.post("/api/ask")
async def ask_everything(request: Request):
    if not LLM_URL:
        raise HTTPException(503, "Notes provider is not configured")
    body = await request.json()
    q = str(body.get("question", "")).strip()[:2000]
    if not q:
        raise HTTPException(400, "question required")
    try:
        return await ask_all(q)
    except Exception as exc:  # noqa: BLE001
        log.exception("ask all failed")
        return JSONResponse({"error": "The private model did not answer. Try again.", "detail": str(exc)[:200]}, status_code=502)


@app.get("/api/meetings/{mid}/export.md")
async def export_md(mid: str):
    with closing(db()) as c:
        d = meeting_detail(c, _mid(mid))
    parts = [f"# {d['title']}", f"*{d['started_at']}*", ""]
    if d["enhanced"]:
        parts += ["## Notes", d["enhanced"]["markdown"].replace(USER_MARK, ""), ""]
    elif d["notes"]:
        parts += ["## My notes", d["notes"], ""]
    if d["segments"]:
        parts.append("## Transcript")
        parts += [f"[{fmt_ms(s['start_ms'])}] {SOURCE_LABEL.get(s['source'], 'Speaker')}: {s['text']}" for s in d["segments"]]
    safe = re.sub(r"[^\w\- ]+", "", d["title"])[:60].strip() or "meeting"
    return PlainTextResponse("\n".join(parts) + "\n", media_type="text/markdown",
                             headers={"Content-Disposition": f'attachment; filename="{safe}.md"'})


@app.delete("/api/meetings/{mid}")
async def delete_meeting(mid: str):
    with closing(db()) as c:
        row = c.execute("SELECT source FROM meetings WHERE id=? AND deleted=0", (_mid(mid),)).fetchone()
        if not row:
            raise HTTPException(404, "meeting not found")
        if row["source"] != "meetings":
            raise HTTPException(403, "imported meetings are read-only")
        c.execute("UPDATE meetings SET deleted=1, updated_at=? WHERE id=?", (now_iso(), mid))
        c.execute("DELETE FROM search WHERE meeting_id=?", (mid,))
    return {"deleted": True}


# ---------------------------------------------------------------- static

from package_routes import install_routes
install_routes(app)


@app.get("/")
async def index(request: Request):
    raw = request.scope.get("raw_path", b"").decode()
    # The old Meetings view is retired: Mizel.ai has one view, Mizel Live (/mizel-live/). Its hash routes
    # (#/m/<id>) match, and the browser carries the hash across the redirect. This server stays the API.
    if not os.environ.get("MEETINGS_EXTERNAL_VIEW"):
        return JSONResponse({"app":"mizel", "api":"/api", "mcp":"/mcp", "view":"Use the installed Mizel Live view or native recorder."})
    return RedirectResponse(os.environ["MEETINGS_EXTERNAL_VIEW"], status_code=302)


@app.get("/{name}")
async def static(name: str):
    if not re.fullmatch(r"[\w.-]+\.(js|css|svg|png|webmanifest|json)", name):
        raise HTTPException(404)
    p = WEB / name
    if not p.is_file():
        raise HTTPException(404)
    types = {"webmanifest": "application/manifest+json", "js": "text/javascript"}
    ext = name.rsplit(".", 1)[1]
    return FileResponse(p, media_type=types.get(ext), headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(app, host=os.environ.get("MEETINGS_HOST", "127.0.0.1"), port=int(os.environ.get("MEETINGS_PORT", "8973")),
                log_level="warning")
