"""Disk-backed playback stitching: bounded RAM, separate tracks mixed a block at a time."""
import audioop
import hashlib
import os
from pathlib import Path
import tempfile
import wave


def playback(rows, cache_root):
    cache_root = Path(cache_root); cache_root.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(repr(rows).encode()).hexdigest()
    result = cache_root / (key+'.wav')
    if result.is_file():
        return result
    with tempfile.TemporaryDirectory(dir=cache_root, prefix='mix-') as folder:
        tracks = {}
        try:
            for source, start_ms, path in rows:
                if not 0 <= start_ms <= 6*60*60*1000:
                    raise ValueError('media timeline out of range')
                if source not in tracks:
                    tracks[source] = open(Path(folder)/source,'w+b')
                with wave.open(path,'rb') as w:
                    if w.getframerate()!=16000 or w.getnchannels()!=1 or w.getsampwidth()!=2:
                        raise ValueError('unsupported stored audio')
                    pcm=w.readframes(w.getnframes())
                tracks[source].seek(start_ms*32); tracks[source].write(pcm)
            sizes = [f.seek(0,os.SEEK_END) for f in tracks.values()]
            total = max(sizes,default=0)
            if total > 6*60*60*32000:
                raise ValueError('recording exceeds timeline limit')
            for f in tracks.values(): f.seek(0)
            temp = Path(folder)/'output.wav'
            with wave.open(str(temp),'wb') as out:
                out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000)
                for offset in range(0,total,65536):
                    length=min(65536,total-offset)
                    mixed=b'\0'*length
                    for f in tracks.values():
                        block=f.read(length).ljust(length,b'\0')
                        mixed=audioop.add(mixed,block,2)
                    out.writeframesraw(mixed)
            os.replace(temp,result)
        finally:
            for f in tracks.values(): f.close()
    return result
