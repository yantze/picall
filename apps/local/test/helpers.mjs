import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/config.js';
import { DurableRuntime } from '../src/durable-runtime.js';
import { Logger } from '../src/logger.js';
import { createApp } from '../src/server.js';

export async function mockServices(t) {
  const state = { requests: [], authorizations: [], inflight: 0, peak: 0, search: 0, reader: 0, source: 0, mode: 'normal', delay: 0, sockets: new Set() };
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/web/search')) { state.search++; res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({web:{results:[{title:'Fixture source',url:state.base+'/source',description:'Current reliable source'}]}})); return; }
    if (req.url.startsWith('/reader')) { state.reader++; if(state.readerDelay)await new Promise(resolve=>setTimeout(resolve,state.readerDelay)); if(res.destroyed)return;res.writeHead(200, {'content-type':'text/plain'}); res.end('Title: Fixture\nMarkdown Content:\nThe verified answer is 42.'); return; }
    if (req.url.startsWith('/source')) { state.source++; res.writeHead(200, {'content-type':'text/plain'}); res.end('The verified answer is 42.'); return; }
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw=''; for await (const chunk of req) raw += chunk;
    const data=JSON.parse(raw); state.requests.push(data);state.authorizations.push(req.headers.authorization);
    state.inflight++;state.peak=Math.max(state.peak,state.inflight);res.once('close',()=>{state.inflight--;});
    if(state.rateLimit>0){state.rateLimit--;res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'SECRET_PROVIDER_BODY_CANARY '+req.headers.authorization}}));return;}
    const last=data.messages.findLastIndex(message=>message.role==='user');
    const question=JSON.stringify(data.messages[last]?.content || '');
    if (question.includes('FAIL')) {res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'SECRET_PROVIDER_BODY_CANARY',type:'authentication_error'}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'fixture-reply',object:'chat.completion.chunk',model:data.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    chunk({role:'assistant'});
    const tools=data.messages.slice(last+1).filter(message=>message.role==='tool');
    const custom=question.includes('CUSTOM');
    const research=question.includes('RESEARCH') || question.includes('LOOP') || custom;
    if (state.delay || question.includes('SLOW')) { chunk({content:'Unfinished intermediate content'}); await new Promise(resolve=>setTimeout(resolve,state.delay || 800)); if(res.destroyed)return; }
    if(research && (tools.length<(custom?1:2) || question.includes('LOOP'))){
      chunk({content:'Intermediate research narration must not leak.'});
      const name=custom?'lookup_document':tools.length===0 || question.includes('LOOP') ? 'web_search':'fetch_content';
      chunk({tool_calls:[{index:0,id:'call_'+state.requests.length,type:'function',function:{name,arguments:JSON.stringify(custom?{q:'verified'}:name==='web_search'?{query:'verified question '+tools.length}:{url:state.base+'/source'})}}]});
      chunk({},'tool_calls');
    }else if(question.includes('EMPTY')) chunk({},'stop');
    else { chunk({content:question.includes('LENGTH')?'Incomplete answer':'The final verified answer is 42.'});chunk({},question.includes('LENGTH')?'length':'stop'); }
    res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,prompt_tokens_details:{cached_tokens:3}}})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.on('connection',socket=>{state.sockets.add(socket);socket.on('close',()=>state.sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  state.base='http://127.0.0.1:'+server.address().port;
  state.net=(url,options)=>fetch(String(url).startsWith('https://r.jina.ai/')?state.base+'/reader':url,options);
  t.after(async()=>{for(const socket of state.sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  return state;
}
export async function setup(t, patch={}, options={}) {
  const services=options.services || await mockServices(t);
  const dataDir=options.dataDir || await mkdtemp(join(tmpdir(),'picall-durable-test-'));
  const store=new ConfigStore({dataDir});await store.load();
  await store.update({modelApiKey:'!literal-model-fixture',modelBaseUrl:services.base+'/v1',defaultModel:'fixture-model',
    braveApiKey:'brave-fixture-key',braveBaseUrl:services.base,requestTimeoutSeconds:20,...patch});
  const logger=new Logger();
  const runtime=new DurableRuntime({dataDir,getConfig:()=>store.value,logger,fetch:services.net,...options.runtime});
  const app=createApp({configStore:store,runtime,logger});await app.ready;
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  const request=(path,{body,headers={},method='GET',...rest}={})=>fetch(base+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),...rest});
  t.after(async()=>{await app.close();logger.close();if(!options.dataDir)await rm(dataDir,{recursive:true,force:true});});
  return {services,store,logger,runtime,app,base,request,dataDir};
}
export const completion=(content='PING',extra={})=>({messages:[{role:'user',content}],...extra});
export async function until(check,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Condition timeout');}
