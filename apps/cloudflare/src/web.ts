import type { Env } from './index';
import { routeAPI } from './http';
import { readBody, json, fail } from './core';
import { createResearchTools } from '../../../packages/tools/index.js';
import { modelInfo } from '../../../packages/core/openai.js';
import { configuredModelInfo } from './models';
import type { ManagementState, CloudConfig } from './management';
import { itemPagination } from '../../../packages/core/session-items.js';

const cookieName='__Host-picall-admin';
const sessionCookie=(request:Request)=>request.headers.get('cookie')?.split(';').map(value=>value.trim()).find(value=>value.startsWith(cookieName+'='))?.slice(cookieName.length+1) || '';
export async function managementRoute(request:Request, env:Env):Promise<Response|undefined> {
  const path=new URL(request.url).pathname;
  if(path==='/health')return json({status:'ok',version:'0.9.0',deployment:'cloudflare'});
  if(['/', '/app.js','/styles.css','/session.js','/session.css'].includes(path) && request.method==='GET') return env.ASSETS.fetch(request);
  if(/^\/sessions\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(path) && request.method==='GET') {
    // Assets canonicalizes .html URLs with a redirect. Request its canonical
    // asset path internally so the browser keeps /sessions/{id} on reload.
    const asset=new URL(request.url);asset.pathname='/session';return env.ASSETS.fetch(new Request(asset,request));
  }
  if(!path.startsWith('/api/'))return undefined;
  const origin=request.headers.get('origin');
  if(request.headers.get('sec-fetch-site')==='cross-site' || (origin && origin!==new URL(request.url).origin) || (!['GET','HEAD'].includes(request.method) && origin!==new URL(request.url).origin)) fail('forbidden',403);
  const admin=env.MANAGEMENT.getByName('global'), token=sessionCookie(request);
  if(path==='/api/auth/status' && request.method==='GET') return json({required:true,authenticated:await admin.authenticated(token),deployment:'cloudflare'});
  if(path==='/api/auth/login' && request.method==='POST') {
    const body:any=await readBody(request);
    if(typeof body.token!=='string' || body.token.length>4096)fail('invalid_management_token',401);
    const session=await admin.login(body.token);
    return json({authenticated:true},200,{'Set-Cookie':`${cookieName}=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`});
  }
  if(!await admin.authenticated(token))fail('management_login_required',401);
  if(path==='/api/auth/logout' && request.method==='POST') {
    await admin.logout(token);return json({authenticated:false},200,{'Set-Cookie':`${cookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`});
  }
  if(path==='/api/config' && request.method==='GET')return json(JSON.parse(await admin.describe()));
  if(path==='/api/config' && request.method==='PUT')return json(JSON.parse(await admin.save(await readBody(request) as Record<string,unknown>)));
  if(path==='/api/key' && request.method==='POST')return json({apiKey:'pc-'+crypto.randomUUID()+crypto.randomUUID()});
  if(path==='/api/status' && request.method==='GET') {
    await admin.getConfig();
    const state:ManagementState=JSON.parse(await admin.state());
    return json({version:'0.9.0',deployment:'cloudflare',uptime:0,runtime:{kind:'pi-harness',available:true,version:'1.5.0',storage:'durable-object-sqlite',recovery:true,recoveredTasks:null},
      capabilities:{managementRuns:true,localLimits:false,modelProviders:true,logDelivery:'poll'},
      sessions:{total:state.sessions.length,busy:state.sessions.filter(session=>session.busy).length},requests:state.requests,authRequired:true});
  }
  if(path==='/api/sessions' && request.method==='GET')return json({sessions:(JSON.parse(await admin.state()) as ManagementState).sessions});
  if(path.startsWith('/api/sessions/') && request.method==='GET') {
    let id:string;
    try { id=decodeURIComponent(path.slice('/api/sessions/'.length)); } catch { return fail('invalid_session_id',400); }
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))fail('invalid_session_id',400);
    const page=itemPagination(new URL(request.url).searchParams);
    const session=(JSON.parse(await admin.state()) as ManagementState).sessions.find(session=>session.id===id);
    if(!session)fail('session_not_found',404);
    const response=await env.SESSIONS.getByName(id).fetch(`https://internal/items?after=${page.after}&limit=${page.limit}`);
    if(!response.ok)return response;
    return json({session,...await response.json() as object});
  }
  if(path.startsWith('/api/sessions/') && request.method==='DELETE') {
    const id=decodeURIComponent(path.slice('/api/sessions/'.length));
    const response=await env.SESSIONS.getByName(id).fetch('https://internal/close',{method:'POST'});return response;
  }
  if(path==='/api/logs' && request.method==='GET')return json({logs:(JSON.parse(await admin.state()) as ManagementState).logs});
  if(path==='/api/models' && request.method==='GET') {
    const config:CloudConfig=JSON.parse(await admin.getConfig());
    return json({models:config.modelProvider==='openai-compatible' && !config.modelApiKey?[]:[configuredModelInfo(env,config)]});
  }
  if(path==='/api/capabilities' && request.method==='GET') {
    const config:CloudConfig=JSON.parse(await admin.getConfig());
    return json({runtime:{kind:'pi-harness'},tools:config.enableResearch?createResearchTools(config).tools.map(tool=>({name:tool.name,description:tool.description,enabled:config.toolOverrides?.[tool.name]!==false,defaultEnabled:true,active:config.toolOverrides?.[tool.name]!==false})):[]});
  }
  if(path==='/api/playground' || path.startsWith('/api/runs')) {
    const url=new URL(request.url);url.pathname=path==='/api/playground'?'/v1/chat/completions':path.replace(/^\/api/,'/v1');
    return routeAPI(new Request(url,request),env,true);
  }
  fail('not_found',404);
}
