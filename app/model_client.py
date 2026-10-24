"""App-scoped Router model runs; no provider credentials or direct fallback."""
import json
import os
import httpx


def model_configured():
    return bool(os.getenv('WIZARD_ROUTER_URL') and os.getenv('WIZARD_ROUTER_GRANT'))


class ModelText(str):
    """Keep validated Router provenance alongside the compatible text return value."""
    provenance: dict

    def __new__(cls, text, provenance):
        result = super().__new__(cls, text)
        result.provenance = provenance
        return result


async def model_run(messages, *, feature='recap', max_tokens=3000, timeout=180):
    if not model_configured():
        raise RuntimeError('Connection Router URL and app grant are required')
    if feature not in ('live-summary', 'recap'):
        raise ValueError('Undeclared model feature')
    system = '\n\n'.join(m['content'] for m in messages if m['role'] == 'system')
    body = {'system': system, 'messages': [m for m in messages if m['role'] != 'system'],
            'max_tokens': max_tokens, 'stream': True}
    output, provenance, event, data, size = [], None, '', [], 0

    def admit():
        nonlocal provenance, event, data
        if not data:
            event = ''
            return
        if provenance:
            raise RuntimeError('Connection Router emitted events after completion')
        value = json.loads('\n'.join(data))
        kind = value.get('type', event)
        if kind == 'error' or event == 'error':
            raise RuntimeError('Connection Router rejected the model call')
        if kind in ('delta', 'text'):
            if not isinstance(value.get('text'), str):
                raise RuntimeError('Connection Router returned invalid text')
            output.append(value['text'])
        elif kind == 'done':
            if (not all(isinstance(value.get(k), str) and value[k] for k in ('model', 'provider', 'tier', 'tested_on'))
                    or value.get('chosen') not in ('match', 'owner-pick', 'owner-swap') or not isinstance(value.get('usage'), dict)):
                raise RuntimeError('Connection Router completion has no verified provenance')
            provenance = value
        else:
            raise RuntimeError('Connection Router returned an unexpected event')
        event, data = '', []

    router = os.environ['WIZARD_ROUTER_URL'].rstrip('/')
    async with httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False) as client:
        async with client.stream('POST', f'{router}/v1/models/{feature}/run',
                                 headers={'X-Wizard-Grant': os.environ['WIZARD_ROUTER_GRANT']}, json=body) as response:
            response.raise_for_status()
            if not response.headers.get('content-type', '').startswith('text/event-stream'):
                raise RuntimeError('Connection Router did not return SSE')
            async for line in response.aiter_lines():
                size += len(line)
                if size > 1024 * 1024:
                    raise RuntimeError('Connection Router response too large')
                if not line:
                    admit()
                elif line.startswith('event:'):
                    event = line[6:].strip()
                elif line.startswith('data:'):
                    data.append(line[5:].lstrip())
            admit()
    if not provenance:
        raise RuntimeError('Connection Router completion has no verified provenance')
    text = ''.join(output).strip()
    if not text:
        raise RuntimeError('The configured model returned an empty answer')
    return ModelText(text, provenance)
