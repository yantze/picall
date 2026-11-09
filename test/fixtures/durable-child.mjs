import { DurableRuntime } from '../../src/durable-runtime.js';
import { ConfigStore } from '../../src/config.js';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
const [dataDir,base,phase]=process.argv.slice(2);
const store=new ConfigStore({dataDir});await store.load();
let blocked=false;
const runtime=new DurableRuntime({dataDir,getConfig:()=>store.value,fetch:(url,options)=>fetch(String(url).startsWith('https://r.jina.ai/')?base+'/reader':url,options),
  checkpoint:async(name,id)=>{if(name===phase&&!blocked){blocked=true;process.send({event:'checkpoint',phase:name,id});await new Promise(()=>{});}},
});
try {await runtime.open();process.send({event:'ready'});}catch(error){process.send({event:'boot-error',code:error.code,message:error.message});process.exit(1);}
process.on('message',async message=>{
  try {
    let value;
    if(message.type==='submit')value=await runtime.submit(message.input,message.options);
    else if(message.type==='get')value=await runtime.get(message.id);
    else if(message.type==='wait')value=await runtime.wait(message.id);
    else if(message.type==='cancel')value=await runtime.cancel(message.id);
    else if(message.type==='inspect'){
      const run=runtime.index.get(message.id),handle=runtime.handles.get(run.sessionId);
      value={run,submissions:(await handle.storage.scanSubmissions({conversationId:handle.root.id},100,undefined,BG)).items};
    }
    else if(message.type==='close'){await runtime.close();process.send({event:'closed',request:message.request});process.exit(0);}
    process.send({event:'response',request:message.request,value});
  }catch(error){process.send({event:'response',request:message.request,error:{code:error.code,message:error.message,status:error.status}});}
});
