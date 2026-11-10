import { convertV4MiniflareOptions, type Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
export const bindings = {
  API_BEARER: 'test-only',
  ADMIN_TOKEN: 'management-test-token-not-a-production-secret',
  CONFIG_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  MODEL: '@cf/zai-org/glm-5.3-flash',
  BRAVE_BASE_URL: 'https://brave.vastiny.com/res/v1',
  TAVILY_BASE_URL: 'https://tavily.vastiny.com',
  BRAVE_KEY: 'mock',
  TINYFISH_KEY: 'mock',
  HTTP_TOOLS: '[]',
};
export const options = (persist: string, extra: Record<string, string> = {}, entry = 'mock-worker.js') => ({
  ...convertV4MiniflareOptions({
    modules: [{ type: 'ESModule' as const, path: fileURLToPath(new URL('../test-dist/' + entry,import.meta.url)) }],
    compatibilityDate: '2026-11-07',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { ...bindings, ...extra },
    durableObjects: {
      SESSIONS: { className: 'SearchSession', useSQLite: true },
      KEYS: { className: 'RequestKey', useSQLite: true },
      MANAGEMENT: { className:'Management', useSQLite:true },
    },
    name: 'picall-runtime-test',
    durableObjectsPersist: persist,
  }),
  resourcePersistencePath: persist,
});
export const headers = {
  Authorization: 'Bearer test-only',
  'Content-Type': 'application/json',
};
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const withAssets = (config: ReturnType<typeof options>) => ({ ...config, workers:config.workers.map(worker=>({ ...worker, config:{...worker.config,
  env:{...worker.config.env,ASSETS:{type:'assets' as const}},
  assets:{directory:fileURLToPath(new URL('../../../packages/ui/',import.meta.url)),hasUserWorker:true,runWorkerFirst:true},
} })) });
export async function req(
  mf: Miniflare,
  path: string,
  body?: unknown,
  extra: any = {},
) {
  return mf.dispatchFetch('https://test' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
export async function settled(mf: Miniflare, id: string) {
  for (let i = 0; i < 140; i++) {
    const r = await req(mf, '/v1/runs/' + id);
    const data: any = await r.json();
    if (!['pending', 'running'].includes(data.status)) return data;
    await wait(150);
  }
  throw new Error('run did not settle');
}
