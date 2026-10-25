"""Owner framing regressions: inspect real built requests, never call an LLM."""
import pytest
from test_package import run_test


@pytest.mark.parametrize('configured, expected', [
    ('James', 'James'), ('  Alex  ', 'Alex'), (None, 'the device owner'), ('  ', 'the device owner'),
])
def test_owner_in_every_backend_recording_prompt(tmp_path, monkeypatch, configured, expected):
    if configured is None:
        monkeypatch.delenv('MEETINGS_OWNER_NAME', raising=False)
    else:
        monkeypatch.setenv('MEETINGS_OWNER_NAME', configured)

    async def test(s, c):
        m = (await c.post('/api/meetings', json={})).json()
        mid = m['id']
        # The real failure: one mic labels both people Me, with a self-introduction.
        line = 'Testing, testing, are we working? I am doing an SS recording with Novaire.'
        with s.db() as db:
            db.execute('INSERT INTO segments VALUES (?,?,?,?,?,?,?)', ('s1', mid, 'me', 0, 5000, line, 0))
            db.execute('INSERT INTO asks(id,meeting_id,question,status,created_at) VALUES (?,?,?,?,?)',
                       ('a1', mid, 'Who recorded this?', 'running', s.now_iso()))
            s.reindex(db, mid)
        requests = []

        async def fake_llm(messages, **kwargs):
            requests.append(messages)
            return '# Fixture title\n\n## Summary\nFixture [E1]'

        monkeypatch.setattr(s, 'llm', fake_llm)
        await s.run_enhance(mid, 'general')
        await s.run_ask('a1', mid, 'Who recorded this?')
        await s.ask_all('Novaire')
        assert len(requests) == 3
        for messages in requests:
            system, user = messages
            assert system['role'] == 'system'
            prompt = system['content']
            assert f'Recording owner: {expected}.' in prompt
            assert f'{expected} is the recorder and the owner of these notes' in prompt
            assert f'Lines labelled Me come from {expected}' in prompt
            assert "other people's speech can also appear under Me" in prompt
            assert 'not track labels alone' in prompt
            assert f'means {expected} is recording and X is the other participant' in prompt
            assert 'never as Me in titles' in prompt
            assert f"'{expected} & X: topic'" in prompt
            assert line in user['content']
            assert 'Me:' in user['content']
            if configured != 'James':
                assert 'James' not in prompt
        assert 'Use \'Me\' for' not in requests[0][0]['content']
        assert '{owner_identity}' not in requests[0][0]['content']
        assert '{sections}' not in requests[0][0]['content']
        with s.db() as db:
            assert db.execute('SELECT enhance_state FROM meetings WHERE id=?', (mid,)).fetchone()[0] == 'idle'
    run_test(tmp_path, test)
