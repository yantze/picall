import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const execute=promisify(execFile), root=fileURLToPath(new URL('../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'picall-package-'));
try {
  const {stdout}=await execute('npm',['pack','--json','--pack-destination',directory],{cwd:root});
  const packed=JSON.parse(stdout)[0];
  assert.ok(packed.files.some(file=>file.path==='packages/ui/index.html'));
  assert.ok(packed.files.some(file=>file.path==='apps/local/src/durable-runtime.js'));
  assert.ok(!packed.files.some(file=>/^(apps\/cloudflare|node_modules|test|\.env)/.test(file.path)));
  const installed=join(directory,'installed');
  await execute('npm',['install','--prefix',installed,'--omit=dev','--ignore-scripts',join(directory,packed.filename)],{cwd:directory});
  for(const name of ['agents','wrangler','miniflare','playwright'])await assert.rejects(stat(join(installed,'node_modules',name)),{code:'ENOENT'});
  const location=join(installed,'node_modules','@yantze','picall');
  const script=`
    import assert from 'node:assert/strict';
    import {pathToFileURL} from 'node:url';
    const base=pathToFileURL(process.argv[1]+'/');
    const {ConfigStore}=await import(new URL('apps/local/src/config.js',base));
    const {DurableRuntime}=await import(new URL('apps/local/src/durable-runtime.js',base));
    const {createApp}=await import(new URL('apps/local/src/server.js',base));
    const {Logger}=await import(new URL('apps/local/src/logger.js',base));
    const store=new ConfigStore({dataDir:process.argv[2]});await store.load();
    const logger=new Logger(),runtime=new DurableRuntime({dataDir:store.dataDir,getConfig:()=>store.value,logger});
    const app=createApp({configStore:store,runtime,logger});
    try {await app.ready;await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
      const url='http://127.0.0.1:'+app.server.address().port;
      assert.equal((await fetch(url+'/health')).status,200);
      assert.match(await(await fetch(url)).text(),/PiCall/);
      const status=await(await fetch(url+'/api/status')).json();assert.equal(status.runtime.kind,'pi-durable');
    } finally {await app.close();logger.close();}
  `;
  await execute(process.execPath,['--input-type=module','-e',script,location,join(directory,'data')],{cwd:directory});
  const help=await execute(process.execPath,[join(location,'bin/picall.js'),'--help'],{cwd:directory});assert.match(help.stdout,/Pi Durable/);
  console.log(JSON.stringify({passed:true,version:packed.version,files:packed.files.length,checks:['standalone npm tarball','shared assets','real SQLite startup','no Cloudflare runtime dependencies']}));
} finally {await rm(directory,{recursive:true,force:true});}
