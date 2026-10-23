"""Read completeness and legacy-base regression for the installed Mizel backend."""
import json
from test_package import run_test


def test_full_transcript_pagination_and_search_all_meetings(tmp_path):
    async def test(s,c):
        assert (await c.get('/')).json()['app'] == 'mizel'
        for prefix in ('', '/meetings'):
            assert (await c.get(prefix+'/healthz')).json()['ok'] is True
            assert (await c.get(prefix+'/api/meetings')).json() == {'meetings': []}
        m = (await c.post('/api/meetings', json={'title': 'completeness fixture'})).json()
        expected = [('segment%04d ' % i) + ('long words ' * 45) for i in range(548)]
        with s.db() as db:
            for i, text in enumerate(expected):
                db.execute('INSERT INTO segments(id,meeting_id,source,start_ms,end_ms,text,ord) VALUES (?,?,?,?,?,?,?)',
                           ('s_%d' % i,m['id'],'me',i*1000,(i+1)*1000,text,i))
            s.reindex(db,m['id'])
        all_segments = []
        offset = 0
        while True:
            result = (await c.post('/meetings/mcp',json={'jsonrpc':'2.0','id':offset,'method':'tools/call','params':{
                'name':'get_transcript','arguments':{'id':m['id'],'offset':offset,'limit':100}}})).json()['result']
            assert result['isError'] is False
            page = result['structuredContent']
            assert json.loads(result['content'][0]['text']) == page
            assert page['total_segments'] == 548
            assert page['offset'] == offset
            all_segments.extend(page['segments'])
            if not page['has_more']:
                assert page['next_offset'] is None
                break
            assert page['next_offset'] > offset
            offset = page['next_offset']
        assert [x['text'] for x in all_segments] == expected
        assert len((await c.get('/meetings/api/meetings/'+m['id'])).json()['segments']) == 548
        # Bury the match behind a full recent-list window. Search must query the full index.
        for i in range(205):
            await c.post('/api/meetings',json={'title':'other fixture %d' % i})
        search = (await c.post('/mcp',json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{
            'name':'search_meetings','arguments':{'query':'segment0547','limit':200}}})).json()['result']['structuredContent']
        assert [x['id'] for x in search['meetings']] == [m['id']]
    run_test(tmp_path,test)
