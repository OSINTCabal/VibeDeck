"""Real built-in worker harness against loopback providers, no paid calls."""
import asyncio
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Fixture(BaseHTTPRequestHandler):
    calls = []
    read = False
    edited = set()
    started = threading.Event()
    release = threading.Event()

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append(body)
        if body['model']=='slow':
            type(self).started.set()
            type(self).release.wait(20)
            return
        if body['model']=='broken':
            self.send_response(429)
            self.send_header('Content-Type','application/json')
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"Fixture quota unavailable"}}')
            return
        messages = json.dumps(body['messages'])
        tool = None
        if 'READ_REPO' in messages and not self.read:
            type(self).read = True
            tool = {'index':0,'id':'read-fixture','type':'function','function':{'name':'run_typescript','arguments':json.dumps({'code':"async function main() { return await tools.file_system.read_file({path:"+json.dumps(str(Path.cwd()/'worker-fixture.txt'))+"}); }"})}}
        marker = 'BLOCK_WRITE' if 'BLOCK_WRITE' in messages else 'EDIT_REPO' if 'EDIT_REPO' in messages else None
        if marker and marker not in self.edited:
            type(self).edited.add(marker)
            tool = {'index':0,'id':'write-fixture','type':'function','function':{'name':'run_typescript','arguments':json.dumps({'code':"async function main() { return await tools.file_system.write_file({path:"+json.dumps(str(Path.cwd()/'worker-fixture.txt'))+",content:'EDITED_FIXTURE'}); }"})}}
        text = 'REPO_READ_OK' if 'PRIVATE_FIXTURE_CONTENT' in messages else 'WORKER_OK'
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream')
        self.end_headers()
        delta = {'role':'assistant','tool_calls':[tool]} if tool else {'role':'assistant','content':text}
        for payload in [
            {'id':'worker','choices':[{'index':0,'delta':delta,'finish_reason':None}]},
            {'id':'worker','choices':[{'index':0,'delta':{},'finish_reason':'tool_calls' if tool else 'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':5}}
        ]:
            self.wfile.write(('data: '+json.dumps(payload)+'\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')


async def check():
    sys.path[:0] = [str(ROOT/'sidecar'),str(ROOT/'sidecar/provider_tools')]
    from agent_routing import AgentJob, AgentSettings, write_settings
    from provider_task import delegate
    endpoint = ThreadingHTTPServer(('127.0.0.1',0),Fixture)
    threading.Thread(target=endpoint.serve_forever,daemon=True).start()
    config = ''
    for provider, names in [('mistral',['large','broken','slow']),('deepseek',['flash','pro']),('zai',['glm-5.3'])]:
        config += f'[[providers]]\nname="{provider}"\nbackend="generic"\napi_style="openai"\napi_base="http://127.0.0.1:{endpoint.server_port}/v1"\napi_key_env_var=""\n'
        for name in names:
            config += f'[[models]]\nname="{name}"\nalias="{provider}-{name}"\nprovider="{provider}"\n'
    config='active_model="mistral-large"\nconsole_base_url="http://127.0.0.1:'+str(endpoint.server_port)+'"\n'+config
    Path('config.toml').write_text(config)
    Path('worker-fixture.txt').write_text('PRIVATE_FIXTURE_CONTENT')
    try:
        jobs=[AgentJob(provider='deepseek',quality='strong',effort='high',task='Review context',access='context'),
              AgentJob(provider='zai',quality='strong',effort='high',task='Independent review',access='context')]
        results=await delegate(jobs)
        assert all(r['status']=='completed' for r in results),results
        assert [r['model'] for r in results]==['deepseek-pro','zai-glm-5.3'],results
        assert all(r['thinking']=='high' for r in results),results
        assert len(Fixture.calls)==2
        assert all(b.get('reasoning_effort')=='high' for b in Fixture.calls),Fixture.calls
        before=len(Fixture.calls)
        for jobs,automatic in [([AgentJob(provider='missing',task='fail')],False),
                                ([AgentJob(task='duplicate'),AgentJob(task='duplicate')],False),
                                ([AgentJob(task='auto')],True)]:
            try:
                await delegate(jobs,automatic=automatic)
                raise AssertionError('Invalid delegation was accepted')
            except ValueError:
                pass
        assert len(Fixture.calls)==before
        write_settings(AgentSettings(policy='auto'))
        result=await delegate([AgentJob(model='mistral-large',task='READ_REPO: read worker-fixture.txt and report its content.',effort='high',access='read')],automatic=True)
        assert result[0]['status']=='completed',result
        assert 'REPO_READ_OK' in result[0]['text'],json.dumps(Fixture.calls[-1]['messages'])[-6000:]
        assert Path('worker-fixture.txt').read_text()=='PRIVATE_FIXTURE_CONTENT'
        assert Fixture.calls[-1].get('reasoning_effort')=='high'
        result=await delegate([AgentJob(model='mistral-large',task='BLOCK_WRITE: try to change worker-fixture.txt',access='read')])
        assert Path('worker-fixture.txt').read_text()=='PRIVATE_FIXTURE_CONTENT',result
        try:
            await delegate([AgentJob(model='mistral-large',task='Unrequested edit',access='edit')],automatic=True)
            raise AssertionError('Automatic edit accepted')
        except ValueError:
            pass
        lock_name=hashlib.sha256(str(Path.cwd().resolve()).encode()).hexdigest()
        lock_path=Path(os.environ['VIBE_HOME'])/'vibedeck'/('edit-'+lock_name+'.lock')
        with lock_path.open('w') as lock:
            fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
            before=len(Fixture.calls)
            result=await delegate([AgentJob(model='mistral-large',task='Avoid concurrent edits',access='edit')])
            assert result[0]['status']=='failed' and len(Fixture.calls)==before
        result=await delegate([AgentJob(model='mistral-large',task='EDIT_REPO: change worker-fixture.txt',access='edit')])
        assert result[0]['status']=='completed',result
        assert Path('worker-fixture.txt').read_text()=='EDITED_FIXTURE',json.dumps(Fixture.calls[-1]['messages'])[-3000:]
        result=await delegate([AgentJob(model='mistral-broken',task='Fail once',access='read')])
        assert result[0]['status']=='failed',result
        assert sum(b['model']=='broken' for b in Fixture.calls)==1,'Repository worker replayed a failed request'
        spawned=[]
        original_spawn=asyncio.create_subprocess_exec
        async def capture(*args,**kwargs):
            process=await original_spawn(*args,**kwargs)
            spawned.append(process)
            return process
        asyncio.create_subprocess_exec=capture
        try:
            pending=asyncio.create_task(delegate([AgentJob(model='mistral-slow',task='Wait for cancellation',access='read')]))
            async with asyncio.timeout(15):
                while not Fixture.started.is_set():
                    await asyncio.sleep(.05)
            pending.cancel()
            try:
                await pending
                raise AssertionError('Cancellation was swallowed')
            except asyncio.CancelledError:
                pass
            assert spawned and all(p.returncode is not None for p in spawned),'Cancelled worker process survived'
        finally:
            asyncio.create_subprocess_exec=original_spawn
            Fixture.release.set()
        print('PASS: exact providers, strong selection, high reasoning on wire, duplicate/automatic gates, repository read/edit tools, blocked read-only writes, single failed attempt, cancellation cleanup; no paid requests')
    finally:
        endpoint.shutdown()


if __name__=='__main__':
    if '--child' in sys.argv:
        asyncio.run(check())
    else:
        cli=Path(shutil.which('vibe')).resolve()
        python=cli.read_text().splitlines()[0][2:]
        with tempfile.TemporaryDirectory(prefix='vibedeck-subagents-') as temporary:
            env={k:v for k,v in os.environ.items() if not k.startswith('VIBE_') and not k.endswith('_API_KEY')}
            env.update(VIBE_HOME=temporary,DO_NOT_TRACK='1',PYTHON_KEYRING_BACKEND='keyring.backends.null.Keyring')
            subprocess.run([python,str(Path(__file__).resolve()),'--child'],cwd=temporary,env=env,check=True,timeout=210)
