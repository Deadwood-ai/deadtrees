"""Existing blinded assessment app-server transport, reused from prediction-audit/judge.py.

Only explicitly supplied images and the bounded evidence tool enter the model.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time

DEADLINE_SECONDS=900
SYSTEM=''

def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def configuration(effort="medium"):
	config = {"model_reasoning_effort": effort, "project_doc_max_bytes": 0, "instructions": "",
		"web_search": "disabled", "approvals_reviewer": "auto_review",
		"features.skip_host_skill_discovery": True}
	for feature in ("shell_tool", "view_image", "apps", "plugins", "remote_plugin",
		"multi_agent", "multi_agent_v2", "skill_search", "memories", "hooks", "goals",
		"browser_use", "browser_use_external", "in_app_browser", "image_generation",
		"shell_snapshot", "sleep_tool", "tool_suggest"):
		config["features." + feature] = False
	return config


def redact(value):
	if isinstance(value, str) and value.startswith("data:image/"):
		return "[inline image sha256=" + hashlib.sha256(value.encode()).hexdigest() + "]"
	if isinstance(value, dict):
		return {k: redact(v) for k, v in value.items()}
	if isinstance(value, list):
		return [redact(v) for v in value]
	return value


def server_command(effort):
    command = [shutil.which('codex'), 'app-server', '--stdio']
    for key, value in configuration(effort).items():
        command += ['-c', key + '=' + json.dumps(value)]
    return command


def invoke(prompt, images, trial, model, effort, notes, command=None, system=SYSTEM):
    """One isolated Codex app-server turn. Returns (final text, receipt)."""
    auth = Path.home() / '.codex/auth.json'
    with tempfile.TemporaryDirectory(prefix='deadtrees-prediction-quality-') as directory:
        assessment_home = Path(directory)
        if command is None:
            if not auth.is_file():
                raise ValueError('Existing Codex file-based login unavailable')
            (assessment_home / 'auth.json').symlink_to(auth)
        (assessment_home / 'empty').mkdir()
        return _invoke(prompt, images, trial, model, effort, notes, command or server_command(effort), assessment_home, system)


def _invoke(prompt, images, trial, model, effort, notes, command, assessment_home, system):
    tool_name = notes.tool['name']
    env = {k: v for k, v in os.environ.items() if k in ('HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM')}
    env['CODEX_HOME'] = str(assessment_home)
    stderr = (trial / 'stderr.txt').open('w')
    proc = subprocess.Popen(command, cwd=assessment_home / 'empty', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=stderr, text=True, bufsize=1)
    lines = queue.Queue()
    def read_lines():
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)
    threading.Thread(target=read_lines, daemon=True).start()
    start = time.monotonic()
    log = (trial / 'events.jsonl').open('w')
    thread_id, tool_calls = None, []

    def send(value):
        proc.stdin.write(json.dumps(value) + '\n')
        proc.stdin.flush()

    def receive():
        remaining = DEADLINE_SECONDS - (time.monotonic() - start)
        if remaining <= 0:
            raise TimeoutError('Inference deadline exceeded')
        line = lines.get(timeout=remaining)
        if line is None:
            raise RuntimeError('Codex app-server exited before completion')
        value = json.loads(line)
        log.write(json.dumps(redact(value)) + '\n')
        log.flush()
        if 'method' in value and 'id' in value:
            params = value.get('params', {})
            if value['method'] != 'item/tool/call' or params.get('tool') != tool_name or params.get('threadId') != thread_id:
                send({'id': value['id'], 'error': {'code': -32601, 'message': f'Only {tool_name} is allowed'}})
                raise ValueError('Unexpected tool or approval request: ' + str(value['method']))
            try:
                reply = {'success': True, 'contentItems': notes.inspect(params.get('arguments'))}
            except ValueError as exc:
                reply = {'success': False, 'contentItems': [{'type': 'inputText', 'text': str(exc)}]}
            tool_calls.append({'call_id': params.get('callId'), 'success': reply['success']})
            send({'id': value['id'], 'result': reply})
        if value.get('method') in ('item/started', 'item/completed'):
            item = value.get('params', {}).get('item', {})
            if item.get('type') not in ('userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall'):
                raise ValueError('Unexpected non-message item: ' + str(item.get('type')))
            if item.get('type') == 'dynamicToolCall' and item.get('tool') != tool_name:
                raise ValueError('Unexpected dynamic tool item')
        return value

    def request(number, method, params):
        send({'id': number, 'method': method, 'params': params})
        while True:
            value = receive()
            if value.get('id') == number and 'method' not in value:
                if 'error' in value:
                    raise ValueError(str(value['error']))
                return value['result']

    try:
        request(1, 'initialize', {'clientInfo': {'name': 'deadtrees-prediction-quality-audit', 'version': '1'},
                                  'capabilities': {'experimentalApi': True}})
        send({'method': 'initialized', 'params': {}})
        settings = {'model': model, 'cwd': str(assessment_home / 'empty'), 'ephemeral': True, 'environments': [],
                    'selectedCapabilityRoots': [], 'dynamicTools': [notes.tool] if notes.enabled else [], 'baseInstructions': system,
                    'developerInstructions': f'Use only the supplied images and optional {tool_name} tool. Return the requested JSON.',
                    'approvalPolicy': 'on-request', 'approvalsReviewer': 'auto_review', 'sandbox': 'read-only',
                    'allowProviderModelFallback': False}
        init = request(2, 'thread/start', settings)
        if init.get('model') != model or init.get('reasoningEffort') != effort or init.get('instructionSources') != []:
            raise ValueError('Unexpected model/effort/inherited instruction receipt')
        thread_id = init['thread']['id']
        inputs = [{'type': 'text', 'text': prompt}]
        for name, data in images:
            mime = 'image/png' if data.startswith(b'\x89PNG\r\n\x1a\n') else 'image/jpeg'
            inputs += [{'type': 'text', 'text': f'Image: {name}'},
                       {'type': 'image', 'url': f'data:{mime};base64,' + base64.b64encode(data).decode(), 'detail': 'original'}]
        write_json(trial / 'input-receipt.json', {
            'system': system, 'command': command, 'thread_start': settings, 'init': init, 'model_requested': model,
            'effort_requested': effort, 'prompt_sha256': digest(prompt.encode()),
            'payload_sha256': digest(json.dumps(inputs).encode()),
            'images': [{'name': n, 'sha256': digest(d), 'bytes': len(d)} for n, d in images],
            'isolation': f'Private config assessment_home; no environments/capability roots; only the optional {tool_name} dynamic tool; other tool or approval requests end the trial.'})
        request(3, 'turn/start', {'threadId': thread_id, 'model': model, 'effort': effort, 'environments': [], 'input': inputs})
        answer_text, usage = None, None
        while True:
            value = receive()
            method, params = value.get('method'), value.get('params', {})
            if method == 'item/completed' and params['item']['type'] == 'agentMessage':
                answer_text = params['item']['text']
            if method == 'thread/tokenUsage/updated':
                usage = params['tokenUsage']
            if method == 'turn/completed':
                if params['turn']['status'] != 'completed':
                    raise ValueError('Turn failed: ' + str(params['turn'].get('error')))
                break
        if not answer_text:
            raise ValueError('No final answer')
        (trial / 'final-response.txt').write_text(answer_text)
        return answer_text, {'init': init, 'effort_requested': effort, 'effort_verified': init.get('reasoningEffort'),
                             'usage': usage, 'tool_calls': tool_calls, 'elapsed_seconds': round(time.monotonic() - start, 3),
                             'cost_usd': None, 'cost_note': 'Subscription inference returns no dollar cost; unknown, not zero.'}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        for stream in (proc.stdin, proc.stdout):
            stream.close()
        log.close()
        stderr.close()

