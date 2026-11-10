import test from 'node:test';
import { Miniflare } from 'miniflare';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { options } from './helpers';
import { assertAPIContract } from '../../../test/api-contract.mjs';
test('shared public API contract on workerd PiHarness',{timeout:30000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'picall-contract-')),mf=new Miniflare(options(dir));
  try { await assertAPIContract((path:string,{method='GET',body,headers={}}:any={})=>mf.dispatchFetch('https://test'+path,{method,headers:{authorization:'Bearer test-only','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})})); }
  finally {await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
