import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { DEFAULTS, SECRET_FIELDS, validate, normalizedConfig } from '../../../packages/core/config.js';
import { fail, hash } from './core';

type Json = null | string | number | boolean | Json[] | { [key:string]:Json };
export type CloudConfig = {
  host:string;port:number;configVersion:number;apiKey:string;maxSessions:number;idleTimeoutMinutes:number;
  requestTimeoutSeconds:number;toolOverrides:Record<string,boolean>;additionalSystemPrompt:string;
  modelBaseUrl:string;modelApiKey:string;defaultModel:string;modelContextWindow:number;modelMaxTokens:number;
  enableResearch:boolean;maxToolRounds:number;braveApiKey:string;tavilyApiKey:string;tinyfishApiKey:string;exaApiKey:string;jinaApiKey:string;
  braveBaseUrl:string;tavilyBaseUrl:string;httpTools:{name:string;description:string;url:string;parameters:Record<string,Json>}[];
  modelProvider:string;aiGatewayId:string;byokAlias:string;
};
type Summary = { id:string; sessionId:string;status:string;createdAt:number;updatedAt:number;model:string;elapsed_ms?:number;usage?:Json;service_calls?:Record<string,number> };
type SessionSummary = { id:string;model:string;busy:boolean;lastUsedAt:number };
type LogItem = { id:number;time:string;level:string;message:string;details:Summary };
export type ManagementState = {sessions:SessionSummary[];requests:{total:number;active:number;failed:number};logs:LogItem[]};
type Sealed = { version: 1; iv: number[]; data: ArrayBuffer };
const TTL = 7 * 86400000;
const LOGIN_TTL = 8 * 3600000;
export async function equalSecret(a: string, b: string) {
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(left, right);
}
function publicConfig(config: CloudConfig, revision: number) {
  const result: Record<string, unknown> = { ...config, revision };
  for (const key of SECRET_FIELDS) {
    const value = String(result[key] || ''); delete result[key];
    result[key + 'Configured'] = Boolean(value);
    result[key + 'Preview'] = value ? '••••' + (value.length > 4 ? value.slice(-4) : '') : '';
  }
  return result;
}
export function validateCloud(config: CloudConfig) {
  const { modelProvider, aiGatewayId, byokAlias, ...common } = config;
  validate(common);
  if (!config.apiKey) fail('api_auth_not_configured', 400);
  if (!['openai-compatible', 'cloudflare-ai-gateway', 'workers-ai'].includes(modelProvider)) fail('invalid_model_provider');
  if (modelProvider !== 'openai-compatible' && (!/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(aiGatewayId) || aiGatewayId.length > 64)) fail('invalid_ai_gateway');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(byokAlias)) fail('invalid_byok_alias');
  if (modelProvider === 'workers-ai' && !config.defaultModel.startsWith('@cf/')) fail('unsupported_model_configuration');
  if (modelProvider === 'cloudflare-ai-gateway' && !['deepseek-flash','deepseek-v4-pro'].includes(config.defaultModel)) fail('unsupported_model_configuration');
}

/** Configuration and administration only: model/tool traffic stays in session DOs. */
export class Management extends DurableObject<Env> {
  private gate: Promise<unknown> = Promise.resolve();
  private locked<T>(fn: () => Promise<T>): Promise<T> { const work = this.gate.then(fn); this.gate = work.catch(() => {}); return work; }
  private async key() {
    try {
      const raw = Uint8Array.from(atob(this.env.CONFIG_ENCRYPTION_KEY || ''), c => c.charCodeAt(0));
      if (raw.length !== 32) throw Error();
      return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt','decrypt']);
    } catch { fail('configuration_encryption_key_unavailable', 503); }
  }
  private async seal(config: CloudConfig): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:new TextEncoder().encode('picall:config:v1') }, await this.key(), new TextEncoder().encode(JSON.stringify(config)));
    return { version:1, iv:Array.from(iv), data };
  }
  private async unseal(record: Sealed): Promise<CloudConfig> {
    if (record.version !== 1) fail('unsupported_config_storage', 503);
    try {
      const raw = await crypto.subtle.decrypt({ name:'AES-GCM', iv:new Uint8Array(record.iv), additionalData:new TextEncoder().encode('picall:config:v1') }, await this.key(), record.data);
      return JSON.parse(new TextDecoder().decode(raw));
    } catch { fail('configuration_decryption_failed', 503); }
  }
  private async read(): Promise<{ config: CloudConfig; revision: number }> {
    const saved = await this.ctx.storage.get<{ sealed:Sealed; revision:number }>('config');
    if (saved) return { config:await this.unseal(saved.sealed), revision:saved.revision };
    const config: CloudConfig = { ...DEFAULTS,
      apiKey:this.env.API_BEARER || '', defaultModel:this.env.MODEL || 'deepseek-flash',
      modelProvider:this.env.MODEL?.startsWith('@cf/') ? 'workers-ai' : 'cloudflare-ai-gateway',
      aiGatewayId:this.env.AI_GATEWAY_ID || 'default', byokAlias:'default',
      braveApiKey:this.env.BRAVE_KEY || '', tavilyApiKey:this.env.TAVILY_KEY || '', tinyfishApiKey:this.env.TINYFISH_KEY || '', exaApiKey:this.env.EXA_KEY || '', jinaApiKey:this.env.JINA_KEY || '',
      braveBaseUrl:this.env.BRAVE_BASE_URL || DEFAULTS.braveBaseUrl, tavilyBaseUrl:this.env.TAVILY_BASE_URL || DEFAULTS.tavilyBaseUrl,
      httpTools:JSON.parse(this.env.HTTP_TOOLS || '[]'),
    };
    validateCloud(config);
    await this.ctx.storage.put('config', { sealed:await this.seal(config), revision:1 });
    await this.ctx.storage.setAlarm(Date.now() + 3600000);
    return { config, revision:1 };
  }
  getConfig():Promise<string> { return this.locked(async () => JSON.stringify((await this.read()).config)); }
  describe() { return this.locked(async () => { const value = await this.read(); return JSON.stringify(publicConfig(value.config, value.revision)); }); }
  save(patch: Record<string, unknown>) {
    return this.locked(async () => {
      const old = await this.read();
      if (patch.revision !== old.revision) fail('config_revision_conflict', 409);
      const { revision:_, ...changes } = patch;
      for (const key of Object.keys(changes)) if (!Object.hasOwn(old.config, key) || ['host','port','configVersion'].includes(key)) fail('unknown_or_readonly_setting');
      const config = normalizedConfig({ ...old.config, ...changes }) as CloudConfig;
      validateCloud(config);
      const revision = old.revision + 1;
      await this.ctx.storage.put('config', { sealed:await this.seal(config), revision });
      return JSON.stringify(publicConfig(config, revision));
    });
  }
  async login(token: string) {
    if (!this.env.ADMIN_TOKEN || this.env.ADMIN_TOKEN.length < 32) fail('management_auth_not_configured', 503);
    return this.locked(async () => {
      const now = Date.now();
      const attempts = await this.ctx.storage.get<{ since:number; count:number }>('login-attempts') || { since:now, count:0 };
      if (now - attempts.since > 300000) { attempts.since=now; attempts.count=0; }
      if (attempts.count >= 30) fail('login_rate_limited', 429);
      attempts.count++; await this.ctx.storage.put('login-attempts', attempts);
      if (!await equalSecret(token, this.env.ADMIN_TOKEN)) fail('invalid_management_token', 401);
      const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2,'0')).join('');
      await this.ctx.storage.put('login:' + await hash(value), { expires:now+LOGIN_TTL, admin:await hash(this.env.ADMIN_TOKEN) });
      await this.ctx.storage.delete('login-attempts');
      await this.ctx.storage.setAlarm(now + 3600000);
      return value;
    });
  }
  async authenticated(token: string) {
    if (!token || !this.env.ADMIN_TOKEN) return false;
    const login = await this.ctx.storage.get<{ expires:number; admin:string }>('login:' + await hash(token));
    return Boolean(login && login.expires > Date.now() && await equalSecret(login.admin, await hash(this.env.ADMIN_TOKEN)));
  }
  async logout(token: string) { await this.ctx.storage.delete('login:' + await hash(token)); }
  async record(run: Summary) {
    // Never persist inputs, tool bodies or secrets in the management index.
    const value = Object.fromEntries(Object.entries(run).filter(([key]) => ['id','sessionId','status','createdAt','updatedAt','model','elapsed_ms','usage','service_calls'].includes(key))) as Summary;
    if (!value.id || !value.sessionId) return;
    return this.locked(async () => {
      const old=await this.ctx.storage.get<Summary>('run:' + value.id);
      const completed=(status:string)=>!['pending','running'].includes(status);
      if(old && (old.updatedAt>value.updatedAt || (completed(old.status) && !completed(value.status))))return;
      if(old?.updatedAt===value.updatedAt && old.status===value.status)return;
      await this.ctx.storage.transaction(async tx=>{
        await tx.put('run:' + value.id,value);
        const id=(await tx.get<number>('log-sequence') || 0)+1;
        const log:LogItem={id,time:new Date(value.updatedAt).toISOString(),level:value.status==='failed'?'warn':'info',message:'Task ' + value.status + '.',details:value};
        await tx.put('log-sequence',id);
        await tx.put('event:' + String(id).padStart(16,'0'),log);
        if(id>1000)await tx.delete('event:' + String(id-1000).padStart(16,'0'));
      });
    });
  }
  async state(): Promise<string> {
    const runs = [...(await this.ctx.storage.list<Summary>({ prefix:'run:' })).values()].sort((a,b)=>a.updatedAt-b.updatedAt);
    const sessions = new Map<string, SessionSummary>();
    for (const run of runs) sessions.set(run.sessionId, { id:run.sessionId, model:run.model, busy:['pending','running'].includes(run.status), lastUsedAt:run.updatedAt });
    return JSON.stringify({ sessions:[...sessions.values()], requests:{ total:runs.length, active:runs.filter(run => ['pending','running'].includes(run.status)).length, failed:runs.filter(run=>run.status==='failed').length },
      logs:[...(await this.ctx.storage.list<LogItem>({prefix:'event:',reverse:true,limit:500})).values()].reverse() });
  }
  async alarm() {
    const now = Date.now();
    const entries = await this.ctx.storage.list<any>();
    const expired = [...entries].filter(([key,value]) => key.startsWith('login:') ? value.expires <= now : key.startsWith('event:') ? Date.parse(value.time)<now-TTL : key.startsWith('run:') && value.updatedAt < now-TTL).map(([key])=>key);
    for(let at=0;at<expired.length;at+=128) await this.ctx.storage.delete(expired.slice(at,at+128));
    await this.ctx.storage.setAlarm(now+3600000);
  }
}
