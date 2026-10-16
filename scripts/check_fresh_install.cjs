// Opt-in installed-launcher check in a disposable, credential-free Linux home.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.VIBEDECK_PLAYWRIGHT);
(async () => {
  assert.equal(process.env.VIBEDECK_FRESH_INSTALL, '1', 'Run only in a disposable fresh-install container');
  const data = process.env.VIBEDECK_DATA || path.join(process.env.HOME,'.local/share/vibedeck');
  assert(!fs.existsSync(path.join(data,'vibedeck.db')), 'Expected a fresh application profile');
  const port = Number(process.env.VIBEDECK_PORT || 18777), debug = port+1;
  const child = spawn(path.join(process.env.HOME,'.local/bin/vibedeck'),
    [...(process.env.VIBEDECK_TEST_HOME ? ['--user-data-dir='+process.env.VIBEDECK_TEST_HOME] : []),'--no-sandbox','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debug],
    {env:{...process.env,VIBEDECK_PORT:String(port),DO_NOT_TRACK:'1'},stdio:'ignore'});
  let browser;
  try {
    for(let n=0;n<100;n++) {
      try {if((await fetch('http://127.0.0.1:'+debug+'/json/version')).ok) break;} catch {}
      assert(child.exitCode===null,'Installed launcher exited before opening Electron');
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:'+debug);
    const page = browser.contexts()[0].pages()[0];
    await page.getByRole('dialog',{name:'Welcome to VibeDeck'}).waitFor();
    await page.getByRole('button',{name:'Sign in to Mistral',exact:true}).waitFor();
    await page.getByRole('button',{name:'Set up later',exact:true}).click();
    const settings = await page.evaluate(()=>fetch('/api/agents/settings').then(r=>r.json()));
    assert.deepEqual(settings,{policy:'requested',quality:'balanced',max_workers:2});
    const providers = await page.evaluate(()=>fetch('/api/providers').then(r=>r.json()));
    assert(providers.providers.some(p=>p.name==='mistral'));
    assert(fs.existsSync(path.join(process.env.VIBE_HOME || path.join(process.env.HOME,'.vibe'),'vibedeck/provider_task.py')));
    assert(fs.existsSync(path.join(process.env.VIBE_HOME || path.join(process.env.HOME,'.vibe'),'vibedeck/agent_routing.py')));
    await page.getByRole('button',{name:'Code',exact:true}).click();
    for(const mode of ['Plan','Full auto','Accept edits','Ask']) {
      await page.getByRole('button',{name:'Select agent',exact:true}).click();
      await page.getByRole('button',{name:mode,exact:true}).click();
      assert((await page.getByRole('button',{name:'Select agent',exact:true}).innerText()).includes(mode));
    }
    console.log('PASS: installed launcher, sidecar boot, first-run sign-in, default Mistral, built-in agents without provider setup, all four coding modes');
    await page.getByRole('button',{name:'Close',exact:true}).click();
  } finally {
    if(browser) await browser.close().catch(()=>{});
    if(child.exitCode===null) child.kill('SIGTERM');
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
