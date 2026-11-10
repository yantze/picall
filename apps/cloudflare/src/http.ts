import type { Env } from './index';
import { publicRun, executionFingerprint, streamResult } from './index';
import { type CloudConfig, equalSecret } from './management';
import { normalize as validateRequest, openAIModel } from '../../../packages/core/protocol.js';
import { modelInfo } from '../../../packages/core/openai.js';
import { identityFingerprint } from '../../../packages/core/identity.js';
import { errorEnvelope } from '../../../packages/core/errors.js';
import { fail, json, errorResponse, hash, normalize as legacyNormalize, readBody } from './core';
import { configuredModelInfo } from './models';
import { appError } from '../../../packages/core/config.js';

const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export async function routeAPI(request: Request, env: Env, management = false): Promise<Response> {
  try {
    const url = new URL(request.url);
    const config:CloudConfig = JSON.parse(await env.MANAGEMENT.getByName('global').getConfig());
    if (!management && !await equalSecret(request.headers.get('authorization') || '', 'Bearer ' + config.apiKey)) fail('invalid_api_key',401);
    const info = modelInfo(config);
    if (request.method==='GET' && url.pathname==='/v1/models') return json({object:'list',data:config.modelProvider==='openai-compatible' && !config.modelApiKey?[]:[openAIModel(configuredModelInfo(env,config))]});
    if (request.method==='GET' && url.pathname.startsWith('/v1/models/')) {
      let id:string;
      try { id=decodeURIComponent(url.pathname.slice('/v1/models/'.length)); }
      catch { throw appError('Invalid model ID.'); }
      if (![info.id,config.defaultModel].includes(id)) fail('model_not_found',404);
      if(config.modelProvider==='openai-compatible' && !config.modelApiKey)fail('model_not_found',404);
      return json(openAIModel(configuredModelInfo(env,config)));
    }
    const asyncRun=url.pathname==='/v1/runs';
    if (request.method==='POST' && (asyncRun || url.pathname==='/v1/chat/completions')) {
      const raw:any=await readBody(request);
      if(asyncRun && (typeof raw.prompt!=='string' || !raw.prompt.trim())) throw appError('prompt must be nonempty text.');
      const task:any=asyncRun ? {messages:[{role:'user',content:raw.prompt}],...(raw.model===undefined?{}:{model:raw.model})} : (({stream,stream_options,...value})=>value)(raw);
      validateRequest(asyncRun?task:raw);
      const explicit=request.headers.get('x-session-id') || undefined;
      if (explicit && !sessionPattern.test(explicit)) fail('invalid_session_id');
      const key=request.headers.get('idempotency-key');
      if (key!==null && !/^[\x21-\x7e]{1,256}$/.test(key)) fail('invalid_idempotency_key');
      const fingerprint=await identityFingerprint(task);
      const coordinator=key ? env.KEYS.getByName(await hash(key)) : undefined;
      let mapping:any=coordinator ? await (await coordinator.fetch('https://internal/lookup',{method:'POST',body:'{}'})).json() : undefined;
      let previous:any;
      if (mapping) {
        if (explicit && explicit!==mapping.session) fail('idempotency_conflict',409);
        const stored=await env.SESSIONS.getByName(mapping.session).fetch('https://internal/result?id='+encodeURIComponent(mapping.run));
        if (stored.ok) previous=await stored.json();
        if (!previous && mapping.version!==2) fail('legacy_run_unavailable',404);
        const expected=mapping.version===2 ? fingerprint : await hash(legacyNormalize(raw,previous?.input?.model || config.defaultModel,asyncRun));
        if (expected!==mapping.fingerprint) fail('idempotency_conflict',409);
      }
      let input:any;
      if (previous) input=previous.input;
      else {
        if (config.modelProvider === 'openai-compatible' && !config.modelApiKey) fail('model_unavailable',503);
        if (task.model!==undefined && ![info.id,config.defaultModel].includes(task.model)) fail('model_not_found',404);
        if (!['off','none',null,undefined].includes(task.reasoning_effort)) fail('unsupported_effort');
        const value=validateRequest(task);
        input={messages:value.messages, ...(value.hasSystemPrompt?{system:value.systemPrompt}:{}),model:info.id,stream:false,includeUsage:false};
        const now=Date.now();
        if (!mapping) {
          const data={fingerprint,session:explicit,version:2,createdAt:now,deadline:now+config.requestTimeoutSeconds*1000,configHash:await executionFingerprint(config)};
          if (coordinator) {
            const response=await coordinator.fetch('https://internal/key',{method:'POST',body:JSON.stringify(data)});
            if (!response.ok) return response;
            mapping=await response.json();
          } else { const session=explicit || crypto.randomUUID(); mapping={...data,session,run:session+'~'+crypto.randomUUID()}; }
        }
      }
      const stub=env.SESSIONS.getByName(mapping.session);
      const accepted=await stub.fetch('https://internal/submit',{method:'POST',body:JSON.stringify({id:mapping.run,session:mapping.session,input,fingerprint:mapping.fingerprint,configHash:mapping.configHash,deadline:mapping.deadline,createdAt:mapping.createdAt})});
      if (!accepted.ok) return accepted;
      const first:any=await accepted.json();
      await env.MANAGEMENT.getByName('global').record(publicRun(first));
      const headers={'X-Session-Id':mapping.session,'X-Run-Id':mapping.run,'Cache-Control':'no-store',Location:'/v1/runs/'+mapping.run};
      if (asyncRun) return json(publicRun(first),202,headers);
      const get=async(signal:AbortSignal)=>{
        const response=await stub.fetch('https://internal/wait?id='+encodeURIComponent(mapping.run),{signal});
        if (!response.ok) fail('result_unavailable',502);
        return await response.json() as any;
      };
      if(raw.stream) return streamResult(first,get,headers,!!raw.stream_options?.include_usage,request.signal);
      let run=first;
      while(['accepted','running'].includes(run.status)) { request.signal.throwIfAborted(); run=await get(request.signal); }
      if(run.status==='succeeded') return json(run.completion,200,headers);
      const result=publicRun(run);return json({...errorEnvelope(result.error!),id:run.id},result.error?.status || 502,headers);
    }
    const match=url.pathname.match(/^\/v1\/runs\/([^/]+)(\/cancel)?$/);
    if (match && ((!match[2] && request.method==='GET') || (match[2] && request.method==='POST'))) {
      let id:string;
      try {id=decodeURIComponent(match[1]);}catch {fail('run_not_found',404);}
      const [session,uuid,...rest]=id!.split('~');
      if(!sessionPattern.test(session) || !uuid || rest.length) fail('run_not_found',404);
      const response=await env.SESSIONS.getByName(session).fetch('https://internal/'+(match[2]?'cancel':'result')+'?id='+encodeURIComponent(id),{method:match[2]?'POST':'GET'});
      if(!response.ok)return response;
      const run=publicRun(await response.json() as any);
      await env.MANAGEMENT.getByName('global').record(run);
      return json(run,200,{'X-Session-Id':session,'X-Run-Id':id});
    }
    fail('not_found',404);
  } catch(error) { return errorResponse(error); }
}
