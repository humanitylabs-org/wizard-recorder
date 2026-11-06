"""Restored live Markdown importers use only explicitly admitted data-local folders."""
from test_package import run_test


def test_live_markdown_importers_are_idempotent_searchable_and_exportable(tmp_path):
    async def check(s, c):
        mz=tmp_path/'imports'/'mizel';mz.mkdir(parents=True)
        an=tmp_path/'imports'/'anarlog';an.mkdir(parents=True)
        (mz/'recording.md').write_text('---\nrecorded_at: "2026-10-22T09:00:00+07:00"\n---\n[00:00:00] Purple bicycle recorded phrase\n[00:00:05] Next imported phrase\n')
        (an/'meeting.md').write_text('---\ncreated_at: "2026-10-22T09:00:00+07:00"\n---\n# Imported project call\n\n## Meeting notes\nA portable note\n\n## Summary\nA portable summary\n\n## Transcript\n[00:00:00] Shared milestone phrase\n')
        s.run_imports();s.run_imports()
        meetings=(await c.get('/api/meetings')).json()['meetings'];assert len(meetings)==2
        assert {m['source'] for m in meetings}=={'mizel','anarlog'}
        imported=(await c.get('/api/meetings?q=milestone')).json()['meetings'];assert len(imported)==1
        detail=(await c.get('/api/meetings/'+imported[0]['id'])).json();assert detail['notes']=='A portable note';assert detail['segments'][0]['text']=='Shared milestone phrase'
        exported=(await c.get('/api/meetings/'+imported[0]['id']+'/export.md')).text;assert 'A portable summary' in exported;assert 'Shared milestone phrase' in exported
    run_test(tmp_path,check)
