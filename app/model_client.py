"""Optional model calls. Router errors never fall back to a different provider."""
import json
import os
import httpx


def model_configured():
    return bool((os.getenv('WIZARD_ROUTER_URL') and os.getenv('WIZARD_ROUTER_GRANT')) or
                (os.getenv('MEETINGS_LLM_URL') and os.getenv('MEETINGS_LLM_MODEL')))


async def model_run(messages, *, feature='recap', max_tokens=3000, timeout=180):
    router = os.getenv('WIZARD_ROUTER_URL', '').rstrip('/')
    async with httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False) as client:
        if router:
            grant = os.getenv('WIZARD_ROUTER_GRANT', '')
            if not grant:
                raise RuntimeError('Connection Router grant is missing')
            r = await client.post(f'{router}/v1/models/{feature}/run',
                                  headers={'X-Wizard-Grant': grant},
                                  json={'messages': messages, 'max_tokens': max_tokens, 'stream': True})
            r.raise_for_status()
            output, provenance = [], None
            event = ''
            for line in r.text.splitlines():
                if line.startswith('event:'):
                    event = line[6:].strip()
                elif line.startswith('data:'):
                    data = json.loads(line[5:].strip())
                    kind = data.get('type', event)
                    if kind == 'error' or event == 'error':
                        raise RuntimeError('Connection Router rejected the model call')
                    if kind in ('delta', 'text') or event in ('delta', 'text'):
                        output.append(data.get('text', data.get('delta', '')))
                    if kind == 'done' or event == 'done':
                        provenance = data
            if not provenance or not provenance.get('model') or not provenance.get('provider'):
                raise RuntimeError('Connection Router completion has no verified provenance')
            text = ''.join(output).strip()
        else:
            if not model_configured():
                raise RuntimeError('Summaries are not configured')
            r = await client.post(os.environ['MEETINGS_LLM_URL'],
                                  headers={'Authorization': 'Bearer '+os.getenv('MEETINGS_LLM_KEY', '')},
                                  json={'model': os.environ['MEETINGS_LLM_MODEL'], 'messages': messages,
                                        'max_tokens': max_tokens, 'temperature': .2})
            r.raise_for_status()
            text = (r.json()['choices'][0]['message'].get('content') or '').strip()
    if not text:
        raise RuntimeError('The configured model returned an empty answer')
    return text
