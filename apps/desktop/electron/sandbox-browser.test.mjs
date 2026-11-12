import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSandboxBrowser } from './sandbox-browser.mjs';

async function fixture(t, options={}) {
  const root=await mkdtemp(path.join(tmpdir(),'aiopc-browser-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[], browsers=[]; let revision=1, heartbeatFails=false;
  const instance=createSandboxBrowser({ app:{getPath:()=>root}, aiopcService:{connection:async()=>({status:'ready',url:'http://127.0.0.1:1',token:'secret'})},
    workspaceStore:{readWorkspaceState:()=>{throw Error('selected company must not be read');}},
    resolveSessionContext:async sessionId=>({sessionId,runtimeId:'runtime',company:'/company-B',projectId:'proj:actual',projectDirectory:'/company-B/projects/actual'}),
    heartbeatMs:10, pollMs:1,
    fetchImpl:async(url,init)=>{
      const u=new URL(url),body=init.body?JSON.parse(init.body):undefined;calls.push({url:u,body});
      if(u.pathname==='/api/environment' && options.multiple && !u.searchParams.get('environment')) return Response.json({error:'select an environment',code:'environment_required'},{status:409});
      if(u.pathname==='/api/environment') return Response.json({id:u.searchParams.get('environment')||'only',bindingRevision:revision,running:true,cdp_url:'http://127.0.0.1:9222'});
      if(body.action==='acquire' && options.queued) return Response.json({state:'queued',requestId:'queued-request',position:1});
      if(body.action==='cancel') assert.equal(init.signal.aborted,false,'cleanup must not reuse an aborted action signal');
      if(body.action==='heartbeat' && heartbeatFails) return Response.json({error:'manual owner now',code:'lease_lost'},{status:409});
      return Response.json(body.action==='acquire'?{state:'granted',leaseId:'lease',expiresAt:Date.now()+60000}:body.action==='begin'?{state:'granted'}:{});
    },
    createBrowser:config=>{
      const browser={config,closed:false,resumes:0,close(){this.closed=true;},resume(){this.resumes++;},async request(body,{signal}){
        config.assertActive();await config.beforeInput();
        if(options.request)return options.request({config,signal,body});return {ok:true};
      }};browsers.push(browser);return browser;
    }
  });t.after(()=>instance.close());return {instance,calls,browsers,setRevision:value=>revision=value,failHeartbeat:()=>heartbeatFails=true};
}

test('browser derives project from trusted requesting session and forwards explicit environment',async t=>{
  const f=await fixture(t);assert.equal((await f.instance.browserTask({sessionId:'ses_actual',operation:'open',environment:'env-2',args:{url:'https://example.com'}})).ok,true);
  assert.equal(f.calls[0].url.searchParams.get('workspace'),'/company-B/projects/actual');
  assert.equal(f.calls[0].url.searchParams.get('environment'),'env-2');
  assert.deepEqual(f.calls.filter(c=>c.body?.action).map(c=>c.body.action),['acquire','begin','heartbeat','end']);
  assert.equal(f.calls[1].body.sessionId,'ses_actual');assert.equal(f.calls[1].body.runtimeId,'runtime');
});
test('browser refuses calls without trusted session before opening any environment',async t=>{
  const f=await fixture(t);assert.equal((await f.instance.browserTask({operation:'tabs'})).code,'missing_session');assert.equal(f.calls.length,0);
});
test('binding revision discards cached browser and persisted tab state key',async t=>{
  const f=await fixture(t);await f.instance.browserTask({sessionId:'ses_actual',operation:'tabs'});f.setRevision(2);await f.instance.browserTask({sessionId:'ses_actual',operation:'tabs'});
  assert.equal(f.browsers.length,2);assert.equal(f.browsers[0].closed,true);assert.notEqual(f.browsers[0].config.statePath,f.browsers[1].config.statePath);
});
test('lease loss cancels an active browser request and closes its connection',async t=>{
  const f=await fixture(t,{request:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  const request=f.instance.browserTask({sessionId:'ses_actual',operation:'act'});
  for(let i=0;!f.browsers.length&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,1));f.failHeartbeat();
  const result=await request;assert.equal(result.code,'lease_lost');assert.equal(f.browsers[0].closed,true);
});
test('handoff keeps a bounded wait hold and ends the operation',async t=>{
  const f=await fixture(t);await f.instance.browserTask({sessionId:'ses_actual',operation:'handoff'});
  assert.deepEqual(f.calls.filter(c=>c.body?.action).map(c=>c.body.action),['acquire','begin','heartbeat','wait','end']);
});

test('multiple bindings never silently choose an environment',async t=>{
  const f=await fixture(t,{multiple:true});const result=await f.instance.browserTask({sessionId:'ses_actual',operation:'tabs'});
  assert.equal(result.code,'environment_required');assert.equal(f.browsers.length,0);
});
test('cancelling a queued browser request removes its waiter with a fresh cleanup signal',async t=>{
  const f=await fixture(t,{queued:true});const controller=new AbortController();
  const request=f.instance.browserTask({sessionId:'ses_actual',operation:'tabs'},{signal:controller.signal});
  for(let i=0;!f.calls.some(call=>call.body?.action==='acquire')&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,1));
  controller.abort(new Error('turn stopped'));await request;
  assert.equal(f.calls.at(-1).body.action,'cancel');assert.equal(f.calls.at(-1).body.requestId,'queued-request');assert.equal(f.browsers.length,0);
});
