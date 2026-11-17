import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Miniflare } from 'miniflare';
import { setup } from '../apps/local/test/helpers.mjs';
import { DurableRuntime } from '../apps/local/src/durable-runtime.js';
import { createApp } from '../apps/local/src/server.js';
import { options,bindings,withAssets } from '../apps/cloudflare/test/helpers.ts';

const cleanups=[],t={after:fn=>cleanups.push(fn)};
const f=await setup(t);
const directory=await mkdtemp(join(tmpdir(),'picall-browser-worker-'));
let mf,application;
const executablePath=process.env.PICALL_CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
const errors=[];
await mkdir('test-results',{recursive:true});
async function checkSessionPanel(page, base, name) {
  await page.locator('[data-view="sessions"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#session-list .session-link').length>0);
  assert.equal(await page.locator('#session-placeholder').isVisible(),true);
  const link=page.locator('#session-list a.session-link').first(),sessionId=await link.getAttribute('data-session-id');
  const marker=await page.evaluate(()=>window.panelDocumentMarker=String(Math.random()));
  await link.click();
  await page.waitForFunction(()=>document.querySelectorAll('.item-row').length>0);
  assert.equal(new URL(page.url()).searchParams.get('session'),sessionId);
  assert.equal(await page.evaluate(()=>window.panelDocumentMarker),marker,'selection must stay in the existing document');
  assert.equal(await page.locator('[data-view="sessions"]').getAttribute('aria-current'),'page');
  // Fetch within Chromium so Secure localhost login cookies are included.
  const items=await page.evaluate(async id=>{const response=await fetch('/api/sessions/'+id);if(!response.ok)throw Error('Session API '+response.status);return response.json();},sessionId);
  assert.equal(await page.locator('.item-row').count(),items.items.length);
  assert.match(await page.locator('#session-items').textContent(),/ms/);
  const list=await page.locator('.sessions-list-panel').boundingBox(),records=await page.locator('.session-records-panel').boundingBox();
  assert.ok(records.x>list.x+list.width,'record panel is to the right of the list');
  const left=await page.locator('.item-content').first().boundingBox(),right=await page.locator('.item-time').first().boundingBox();
  assert.ok(right.x>left.x+left.width);
  await page.locator('.item-content summary').first().click();
  await page.locator('#refresh-records').click();await page.waitForFunction(()=>!document.querySelector('#refresh-records').disabled);
  assert.equal(await page.locator('.item-content details').first().getAttribute('open'),'');
  // A second real session lets us check history, navigation and explicit continuation.
  const second=await page.evaluate(async()=>{
    const response=await fetch('/api/playground',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'PANEL SECOND SESSION'}],stream:false})});
    if(!response.ok)throw Error('Second session '+response.status);
    await response.json();return response.headers.get('x-session-id');
  });
  await page.locator('#refresh-sessions').click();
  const secondLink=page.locator('.session-link').filter({has:page.locator('code',{hasText:second})});await secondLink.click();
  await page.waitForFunction(()=>document.querySelector('#session-items').textContent.includes('PANEL SECOND SESSION'));
  assert.equal(await page.evaluate(()=>window.panelDocumentMarker),marker);
  await page.goBack();await page.waitForFunction(id=>document.querySelector('#session-id').textContent===id && document.querySelector('.item-row'),sessionId);
  assert.equal(await page.locator('#session-items').textContent().then(text=>text.includes('PANEL SECOND SESSION')),false);
  await page.goForward();await page.waitForFunction(()=>document.querySelector('#session-items').textContent.includes('PANEL SECOND SESSION'));
  await page.reload();await page.waitForFunction(()=>document.querySelector('#session-items').textContent.includes('PANEL SECOND SESSION'));
  await page.screenshot({path:`test-results/${name}-sessions-panel.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`test-results/${name}-sessions-panel-mobile.png`,fullPage:true});
  assert.equal(await page.locator('[data-view="sessions"]').textContent().then(text=>text.includes('会话历史')),true);
  assert.equal(await page.locator('.session-close').count(),0);
  assert.match(await page.locator('.session-item.selected .session-state').textContent(),/已完成/);
  assert.match(await page.locator('#session-meta').textContent(),/已完成/);
  assert.equal(await page.locator('#continue-session').isEnabled(),true);
  await page.locator('#continue-session').click();
  assert.equal(await page.locator('#overview-view').isVisible(),true);
  assert.equal(await page.locator('#prompt').inputValue(),'');
  await page.locator('#prompt').fill('PANEL CONTINUED');
  const submitted=page.waitForResponse(response=>response.url().endsWith('/api/playground'));
  await page.locator('#run-button').click();
  const resumed=await submitted;assert.equal(resumed.headers()['x-session-id'],second);
  await page.waitForFunction(()=>document.querySelector('#response-meta').textContent.startsWith('完成'));
  await page.locator('[data-view="sessions"]').click();
  await page.locator('.session-link').filter({has:page.locator('code',{hasText:second})}).click();
  await page.waitForFunction(()=>document.querySelector('#session-items').textContent.includes('PANEL CONTINUED'));
  assert.match(await page.locator('#session-items').textContent(),/PANEL SECOND SESSION/);
  // Legacy direct URLs open the same shell with the sidebar and selected panel.
  await page.goto(base+'/sessions/'+sessionId);await page.waitForFunction(()=>document.querySelectorAll('.item-row').length>0);
  assert.equal(await page.locator('[data-view="sessions"]').isVisible(),true);
  assert.equal(new URL(page.url()).pathname,'/');
  assert.equal(new URL(page.url()).searchParams.get('session'),sessionId);
  await page.goto(base+'/?tab=sessions&session=missing');await page.waitForFunction(()=>!document.querySelector('#session-error').hidden);
  assert.match(await page.locator('#session-error').textContent(),/不存在或已过期/);
  assert.equal(await page.locator('#session-list .session-link').count()>0,true);
  await page.setViewportSize({width:1440,height:1000});await page.goto(base);
  await page.waitForFunction(()=>document.querySelector('#model').value.startsWith('picall/'));
}

async function checkPanelStates(page, base) {
  let failFast=true, liveReads=0, holdMany=false, releaseMany, manyStarted;
  const waitingMany=new Promise(resolve=>{manyStarted=resolve;});
  const blockedMany=new Promise(resolve=>{releaseMany=resolve;});
  let manyFinished;const completedMany=new Promise(resolve=>{manyFinished=resolve;});
  const list=[{id:'panel-many',model:'fixture',busy:false,status:'completed'},{id:'panel-fast',model:'fixture',busy:false,status:'completed'},{id:'panel-live',model:'fixture',busy:true,status:'running'},{id:'panel-empty',model:'fixture',busy:false,status:'completed'}];
  const item=(id,text,duration=5)=>({id,kind:'pi.assistant',conversationId:1,taskId:id,messages:[{role:'assistant',content:[{type:'text',text}]}],timestamp:Date.now(),startedAt:Date.now()-5,endedAt:duration===null?null:Date.now(),durationMs:duration,taskStatus:duration===null?'running':'terminal'});
  const handler=async route=>{
    const url=new URL(route.request().url()),id=url.pathname.split('/').at(-1);
    if(url.pathname==='/api/sessions')return route.fulfill({json:{sessions:list}});
    if(id==='panel-many') {
      if(holdMany){manyStarted();await blockedMany;}
      const after=Number(url.searchParams.get('after'));
      const items=Array.from({length:after?2:50},(_,i)=>item(after+i+1,'Many item '+(after+i+1)));
      await route.fulfill({json:{session:list[0],items,nextCursor:after?null:50}}).catch(()=>{});if(holdMany)manyFinished();return;
    }
    if(id==='panel-fast') {
      if(failFast){failFast=false;return route.fulfill({status:503,json:{error:{message:'fixture temporary outage'}}});}
      return route.fulfill({json:{session:list[1],items:[item(1,'Fast session record')],nextCursor:null}});
    }
    if(id==='panel-live') {
      liveReads++;const done=liveReads>=2;
      return route.fulfill({json:{session:{...list[2],busy:!done,status:done?'completed':'running'},items:[item(1,done?'Live completed':'Live running',done?42:null)],nextCursor:null}});
    }
    return route.fulfill({json:{session:list[3],items:[],nextCursor:null}});
  };
  const routePattern=/\/api\/sessions(?:[/?].*)?$/;
  await page.route(routePattern,handler);
  try {
    await page.goto(base+'/?tab=sessions');
    await page.locator('.session-link[data-session-id="panel-many"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.item-row').length===50);
    await page.locator('#load-more').click();
    await page.waitForFunction(()=>document.querySelectorAll('.item-row').length===52);
    assert.equal(await page.locator('#load-more').isVisible(),false);
    await page.locator('.session-link[data-session-id="panel-fast"]').click();
    await page.waitForFunction(()=>!document.querySelector('#session-error').hidden);
    assert.equal(await page.locator('.item-row').count(),0,'selection must clear the previous transcript during failure');
    await page.locator('#refresh-records').click();
    await page.waitForFunction(()=>document.querySelector('#session-items').textContent.includes('Fast session record'));
    holdMany=true;
    await page.locator('.session-link[data-session-id="panel-many"]').click();await waitingMany;
    await page.locator('.session-link[data-session-id="panel-fast"]').click();
    await page.waitForFunction(()=>document.querySelector('#session-items').textContent.includes('Fast session record'));
    releaseMany();
    // The delayed request is aborted when another session is selected. Wait for
    // its route handler rather than requiring an HTTP response from an abort.
    await completedMany;
    assert.equal(await page.locator('.item-row').count(),1);
    assert.doesNotMatch(await page.locator('#session-items').textContent(),/Many item/);
    await page.locator('.session-link[data-session-id="panel-live"]').click();
    await page.waitForFunction(()=>document.querySelector('#session-items').textContent.includes('Live completed'));
    assert.match(await page.locator('#session-meta').textContent(),/已完成/);
    assert.equal(await page.locator('#continue-session').isEnabled(),true);
    assert.ok(liveReads>=2);assert.match(await page.locator('#session-items').textContent(),/42 ms/);
    await page.locator('.session-link[data-session-id="panel-empty"]').click();
    await page.waitForFunction(()=>!document.querySelector('#items-empty').hidden);
    assert.equal(await page.locator('.item-row').count(),0);
    await page.locator('[data-view="overview"]').click();
    assert.equal(await page.locator('#sessions-view').isVisible(),false);
  } finally {releaseMany();await page.unroute(routePattern,handler);}
  await page.goto(base);await page.waitForFunction(()=>document.querySelector('#model').value.startsWith('picall/'));
}

try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(f.base);
  await page.waitForFunction(()=>document.querySelector('#model').value==='picall/fixture-model');
  assert.equal(await page.locator('#research-budget-mode').inputValue(),'fixed');
  await page.locator('#prompt').fill('RESEARCH');
  await page.locator('#run-button').click();
  await page.waitForFunction(()=>document.querySelector('#response-meta').textContent.startsWith('完成'));
  assert.equal(await page.locator('#response-output').textContent(),'The final verified answer is 42.');
  await checkSessionPanel(page,f.base,'local');
  await checkPanelStates(page,f.base);
  await page.locator('#new-session').click();f.services.delay=1000;
  await page.locator('#prompt').fill('SLOW PING');
  const waiting=page.waitForResponse(response=>response.url().endsWith('/api/playground'));
  await page.locator('#run-button').click();
  const accepted=await waiting,id=accepted.headers()['x-run-id'];assert.ok(id);
  await f.app.close();f.services.delay=0;
  const runtime=new DurableRuntime({dataDir:f.dataDir,getConfig:()=>f.store.value,logger:f.logger,fetch:f.services.net});
  application=createApp({configStore:f.store,runtime,logger:f.logger});await application.ready;
  await new Promise(resolve=>application.server.listen(Number(new URL(f.base).port),'127.0.0.1',resolve));
  await page.reload();await page.waitForFunction(()=>document.querySelector('#model').value==='picall/fixture-model');
  await runtime.wait(id);
  await page.locator('#run-query-id').fill(id);await page.locator('#run-query-form button').click();
  await page.waitForFunction(()=>document.querySelector('#response-meta').textContent.startsWith('完成'));
  assert.equal(await page.locator('#timing-panel').isVisible(),true);
  await page.locator('#timing-panel summary').click();assert.match(await page.locator('#timing-list').textContent(),/模型请求/);
  await checkSessionPanel(page,f.base,'local-restarted');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'test-results/local-mobile.png',fullPage:true});

  let authorization='';
  const config=withAssets(options(directory));
  mf=new Miniflare({...config,workers:config.workers.map(worker=>({...worker,dev:{...worker.dev,outboundService:{type:'fetcher',handler:async request=>{
    assert.equal(new URL(request.url).hostname,'compatible.test');authorization=request.headers.get('authorization');
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:'Compatible gateway pong'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }}}}))});
  const address=await mf.ready;
  const cloud=await browser.newPage({viewport:{width:1440,height:1000}});cloud.on('pageerror',error=>errors.push(error.message));
  await cloud.goto(String(address));await cloud.locator('#management-token').fill(bindings.ADMIN_TOKEN);await cloud.locator('#login-form button').click();
  await cloud.waitForFunction(()=>document.querySelector('#model').value.startsWith('picall/'));
  assert.equal(await cloud.locator('#login-panel').isVisible(),false);
  assert.equal(await cloud.locator('#logout-button').isVisible(),true);
  await cloud.locator('[data-view="settings"]').click();await cloud.locator('#settings-tab-research').click();
  await cloud.locator('#budget-reminders').uncheck();
  await cloud.locator('#research-budget-mode').selectOption('staged');
  await cloud.locator('#brave-api-key').fill('browser-search-secret-canary');await cloud.locator('#save-button').click();
  await cloud.waitForFunction(()=>document.querySelector('#toast').textContent.includes('设置已保存'));assert.equal(await cloud.locator('#brave-api-key').inputValue(),'');
  assert.equal(await cloud.locator('#budget-reminders').isChecked(),false);
  assert.equal(await cloud.locator('#research-budget-mode').inputValue(),'staged');
  await cloud.locator('[data-view="overview"]').click();await cloud.locator('#prompt').fill('research');await cloud.locator('#run-button').click();
  await cloud.waitForFunction(()=>document.querySelector('#response-meta').textContent.startsWith('完成'));
  assert.match(await cloud.locator('#response-output').textContent(),/Final answer/);
  await checkSessionPanel(cloud,String(address).replace(/\/$/,''),'cloudflare');
  await cloud.locator('#new-session').click();await cloud.locator('#prompt').fill('slow research');await cloud.locator('#run-button').click();
  await cloud.locator('#stop-button').click();await cloud.waitForFunction(()=>document.querySelector('#response-meta').textContent.includes('取消'));
  await cloud.locator('[data-view="settings"]').click();await cloud.locator('#settings-tab-model').click();
  await cloud.locator('#model-provider').selectOption('openai-compatible');await cloud.locator('#model-base-url').fill('https://compatible.test/v1');await cloud.locator('#model-api-key').fill('!literal-browser-model-key');await cloud.locator('#default-model').fill('deepseek-flash');await cloud.locator('#save-button').click();
  await cloud.waitForFunction(()=>document.querySelector('#toast').textContent.includes('设置已保存')&&document.querySelector('#model-api-key').value==='');
  await cloud.locator('[data-view="overview"]').click();await cloud.waitForFunction(()=>document.querySelector('#model').value==='picall/deepseek-flash');
  await cloud.locator('#prompt').fill('ping');await cloud.locator('#run-button').click();await cloud.waitForFunction(()=>document.querySelector('#response-meta').textContent.startsWith('完成'));
  assert.equal(await cloud.locator('#response-output').textContent(),'Compatible gateway pong');assert.equal(authorization,'Bearer !literal-browser-model-key');
  await cloud.reload();await cloud.waitForFunction(()=>document.querySelector('#model').value==='picall/deepseek-flash');
  assert.equal(await cloud.locator('#research-budget-mode').inputValue(),'staged');
  await cloud.setViewportSize({width:390,height:844});assert.ok(await cloud.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await cloud.screenshot({path:'test-results/cloudflare-mobile.png',fullPage:true});
  await cloud.locator('#logout-button').click();await cloud.waitForFunction(()=>!document.querySelector('#login-panel').hidden);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['Node research and restart recovery','local and Worker session history, settled status, explicit continuation by ID and direct reload','shared mobile UI','Worker login and logout','encrypted settings UI','Worker research and explicit cancel','compatible gateway and literal key','page reload without credential storage','no browser exceptions']}));
} finally {
  await browser.close();await application?.close();await mf?.dispose();for(const cleanup of cleanups.reverse())await cleanup();await rm(directory,{recursive:true,force:true});
}
