// A v1-format writer: same pinned Pi storage, root, prefix, native model reference,
// raw Run/History records and RequestKey hash as Cloudflare commit 0573e12.
import { DurableObject } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import { PiHarness } from 'agents/harness/pi';
import { Harness } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { createModelRuntime } from '../src/models';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { normalize,hash,completion,usageDelta } from '../src/core';
import { WebTools } from '../src/tools';

export class Management extends DurableObject {}
export class RequestKey extends DurableObject {
  async fetch(request:Request){await this.ctx.storage.put('key',await request.json());return Response.json({ok:true});}
}
export class SearchSession extends DurableObject<any> {
  ai={run:async(_model:string,input:any,options:any)=>{
    await this.ctx.storage.put('test:model-calls',(await this.ctx.storage.get<number>('test:model-calls') || 0)+1);
    if(JSON.stringify(input).includes('slow'))await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,3000);options?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason);},{once:true});});
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:'Legacy saved answer'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }};
  runtime=createModelRuntime({...this.env,AI:this.ai});
  web=new WebTools(this.env,this.ctx.storage,async()=>({id:await this.ctx.storage.get<string>('active'),deadline:Date.now()+300000}));
  harness=new PiHarness({harness:({storage,context,onWake})=>{const models=createModels();models.setProvider(this.runtime.provider);return Harness.open(storage,{models,registry:this.web.registry(),onWake},context);},defaults:{model:this.runtime.model,maxTurns:8}});
  lifecycle=Lifecycle.install(this).use(this.harness);
  async onRequest(request:Request){
    const {session,id,pending}=await request.json() as any;
    const input=normalize({messages:[{role:'user',content:pending?'slow legacy question':'legacy question'}]},this.env.MODEL);
    const before=await(await this.harness.pi()).usage(BG);
    const run:any={id,session,input,fingerprint:await hash(input),created:Date.now(),deadline:Date.now()+300000,status:'accepted',before,nextHashes:await Promise.all(input.messages.map(hash))};
    await this.ctx.storage.put('run:'+id,run);
    await this.ctx.storage.put('active',id);
    await this.harness.submit(input.messages[0].content,{operationId:id,whenBusy:'reject'});
    if(pending)return Response.json(run);
    const result=await this.harness.wait(id);
    run.status='succeeded';run.usage=usageDelta(await(await this.harness.pi()).usage(BG),before);run.completion=completion(id,input.model,result.text,run.usage,run.created);
    await this.ctx.storage.put('run:'+id,run);
    await this.ctx.storage.put('history',{model:input.model,system:'',hashes:[...run.nextHashes,await hash(run.completion.choices[0].message)]});
    await this.ctx.storage.delete('active');
    return Response.json(run);
  }
}
export default {async fetch(request:Request,env:any){
  const {pending=false,key='legacy-key'}=await request.json() as any;
  const session=crypto.randomUUID(),id=session+'~'+crypto.randomUUID();
  const run=await env.SESSIONS.getByName(session).fetch('https://internal/seed',{method:'POST',body:JSON.stringify({session,id,pending})});
  const record:any=await run.json();
  await env.KEYS.getByName(await hash(key)).fetch('https://internal/key',{method:'POST',body:JSON.stringify({session,run:id,fingerprint:record.fingerprint})});
  return Response.json(record);
}};
