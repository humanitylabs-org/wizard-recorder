"""Offline Mizel/meeting-recorder migration. Run only on a stopped COPY of the data.

Preserves meetings.db and audio bytes. Converts old absolute chunk paths to relative
paths beneath /data. Default is dry-run; --apply makes a SQLite backup before editing.
No source paths are opened outside the supplied data directory.
"""
from pathlib import Path, PurePosixPath
import argparse
import json
import sqlite3


def resolve_audio(root: Path, stored: str) -> Path:
    root = root.resolve()
    path = PurePosixPath(stored)
    if '..' in path.parts:
        raise ValueError('Audio traversal is not allowed')
    # Existing absolute /data paths and old host absolute paths share the audio suffix.
    parts = path.parts
    if 'audio' not in parts:
        raise ValueError('Chunk path must be beneath audio/')
    relative = Path(*parts[parts.index('audio'):])
    result = (root / relative).resolve()
    if not result.is_relative_to(root / 'audio'):
        raise ValueError('Audio must stay in the app data directory')
    return result


def migrate(root: Path, apply=False):
    root = root.resolve()
    database = root / 'meetings.db'
    if not database.is_file():
        raise ValueError('Expected a copied meetings.db with its audio/ folder')
    changes = []
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as c:
        for mid, source, seq, stored in c.execute('SELECT meeting_id,source,seq,path FROM chunks'):
            resolved = resolve_audio(root, stored)
            if not resolved.is_file():
                raise ValueError(f'Missing copied audio for {mid}/{source}/{seq}')
            relative = str(resolved.relative_to(root))
            if relative != stored:
                changes.append((relative, mid, source, seq))
    if apply and changes:
        backup = root / 'pre-recorder-migration.db'
        if backup.exists():
            raise ValueError('Migration backup already exists; inspect it before retrying')
        with sqlite3.connect(database) as c, sqlite3.connect(backup) as b:
            c.backup(b)
        try:
            with sqlite3.connect(database) as c:
                c.executemany('UPDATE chunks SET path=? WHERE meeting_id=? AND source=? AND seq=?', changes)
        except Exception:
            raise  # Original database backup is intentionally retained.
    return {'database': database.name, 'changed_paths': len(changes), 'applied': apply,
            'audio_modified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('data_dir', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(migrate(args.data_dir, args.apply)))
