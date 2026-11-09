import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {until} from './helpers.mjs';
const cli=fileURLToPath(new URL('../bin/picall.js',import.meta.url)),execute=promisify(execFile);
test('CLI documents Durable and rejects removed native-Pi commands with migration guidance',async()=>{
  const help=await execute(process.execPath,[cli,'--help']);assert.match(help.stdout,/Pi Durable/);assert.match(help.stdout,/SQLite/);
  for(const option of ['pi','--workdir','--enable-skills','--no-extensions'])await assert.rejects(execute(process.execPath,[cli,option]),error=>error.code===1&&/removed Coding Agent/.test(error.stderr));
});
test('CLI starts without reading a Pi profile; a second writer fails and SIGKILL releases the directory',async t=>{
  const root=await mkdtemp(join(tmpdir(),'picall-cli-durable-')),profile=join(root,'profile'),data=join(root,'data'),marker=join(root,'should-not-exist');
  await mkdir(join(profile,'extensions'),{recursive:true});await writeFile(join(profile,'extensions','hostile.js'),`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'loaded');export default()=>{};`);
  const children=[];t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}await rm(root,{recursive:true,force:true});});
  const start=async()=>{
    const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const child=spawn(process.execPath,[cli,'--port',String(port),'--data-dir',data],{env:{...process.env,PI_CODING_AGENT_DIR:profile},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});children.push(child);return{child,base:'http://127.0.0.1:'+port,output:()=>output};
  };
  const first=await start();await until(async()=>{try{return(await fetch(first.base+'/health')).ok;}catch{return false;}});
  const status=await(await fetch(first.base+'/api/status')).json();assert.equal(status.runtime.kind,'pi-durable');
  const second=await start();await once(second.child,'exit');assert.equal(second.child.exitCode,1);assert.match(second.output(),/Another PiCall process/);
  first.child.kill('SIGKILL');await once(first.child,'exit');const third=await start();await until(async()=>{try{return(await fetch(third.base+'/health')).ok;}catch{return false;}});
  await assert.rejects(readFile(marker),{code:'ENOENT'});third.child.kill('SIGTERM');await once(third.child,'exit');assert.equal(third.child.exitCode,0);
});
