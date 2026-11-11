import { AgentDoc, GenerationTask, LiveDoc, hook } from '@earendil-works/pi-durable';

const elapsed = start => Math.max(0, Date.now() - start);
const empty = () => ({ version:1, model_requests:0, model_responses:0, model_ms:0, tool_rounds:0, models:[], tools:{}, providers:{} });
const usage = value => Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].map(key=>[key,Number.isFinite(value?.[key])?Math.max(0,value[key]):0]));
const keyFor = id => 'timings:' + id;

/** Metadata only. Each session owns its queue; run IDs are captured before I/O. */
export function createTelemetry(web, { reminders = true, emit = (_event) => {} } = {}) {
  let line = Promise.resolve();
  const requests = new Map();
  async function record(runId, event) {
    const work = line.then(async () => {
      const saved = await web.store.get(keyFor(runId));
      const state = saved ? JSON.parse(JSON.stringify(saved)) : empty();
      if (event.event === 'model_started') {
        // A missing terminal event means interrupted/unknown duration, never downtime.
        for (const entry of state.models) if (entry.status === 'running') entry.status = 'interrupted';
        state.model_requests++;
        state.hard_limit = event.hard_limit; state.budget_reminders = event.budget_reminders;
        state.tool_rounds = Math.max(state.tool_rounds,event.tool_rounds);
        state.models.push({ id:event.id, request:state.model_requests, tool_rounds_before_request:event.tool_rounds,
          sdk_attempt:event.sdk_attempt, startedAt:event.startedAt, status:'running' });
        state.models = state.models.slice(-256);
      } else if (event.event === 'model_finished') {
        const entry = state.models.find(value=>value.id === event.id);
        if (entry && entry.elapsed_ms === undefined) {
          state.model_responses++; state.model_ms += event.elapsed_ms;
          Object.assign(entry,{status:event.status,elapsed_ms:event.elapsed_ms,usage:event.usage});
        }
      } else if (event.event.startsWith('tool_round_')) state.tool_rounds = Math.max(state.tool_rounds,event.tool_rounds);
      else {
        const group = event.event === 'provider_finished' ? state.providers : state.tools;
        const name = event.provider || event.tool;
        const value = Object.hasOwn(group,name) ? group[name] : (group[name] = { completed_requests:0, errors:0, elapsed_ms:0, ...(event.provider ? {headers_ms:0} : {cache_hits:0}) });
        value.completed_requests++; value.errors += event.success ? 0 : 1; value.elapsed_ms += event.elapsed_ms;
        if (event.provider) value.headers_ms += event.headers_ms || 0;
        else value.cache_hits += event.cache_hit ? 1 : 0;
      }
      await web.store.put(keyFor(runId),state);
      await emit({ ...event, runId });
    });
    // Telemetry is not another retry owner. Real storage failure still closes Harness.
    line = work.catch(() => {});
    await line;
  }
  web.observe = (runId,event) => record(runId,event);
  return {
    flush: () => line,
    async toolStarted(api,context) {
      const run=await web.scope(),live=await api.snapshot(LiveDoc,api.conversationId,context);
      await record(run.id,{event:'tool_round_started',tool_rounds:live?.run?.turns || 0});
    },
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        const run = await web.scope();
        const live = await api.snapshot(LiveDoc,api.conversationId,context);
        const agent = await api.snapshot(AgentDoc,api.conversationId,context);
        const rounds = live?.run?.turns || 0, hard = agent?.maxTurns || 8;
        const current = { id:crypto.randomUUID(), runId:run.id, startedAt:Date.now() };
        requests.set(api.taskId,current);
        await record(run.id,{ event:'model_started', id:current.id, startedAt:current.startedAt,
          tool_rounds:rounds, sdk_attempt:live?.generation?.attempt || 0, hard_limit:hard, budget_reminders:reminders });
        if (!reminders) return;
        const seconds = Math.max(0,Math.ceil((run.deadline-Date.now())/1000));
        const text = `RESEARCH BUDGET: ${rounds}/${hard} tool rounds used; ${Math.max(0,hard-rounds)} remaining before the hard cutoff; ${seconds}s until the original deadline. A round reaching the hard limit ends without another answer request. ` +
          'Once retrieved, dated evidence directly answers the question, give the final answer now. Use additional tools only for a specific missing, stale or conflicting fact. Preserve room to finish. Budget pressure never justifies inventing facts or citations; state evidence limitations honestly. Do not include this budget metadata in the final answer.';
        return { messages:[...request.messages,{role:'system',content:'',sections:{'picall.budget':text},timestamp:Date.now()}] };
      },
      async afterResponse(message, api) {
        const current = requests.get(api.taskId);
        if (!current) return;
        requests.delete(api.taskId);
        await record(current.runId,{event:'model_finished',id:current.id,elapsed_ms:elapsed(current.startedAt),
          status:['stop','toolUse','tool_calls','length','error','aborted'].includes(message.stopReason)?message.stopReason:'other',usage:usage(message.usage)});
      },
      async afterTools(_assistant, _results, api, context) {
        const run = await web.scope(),live=await api.snapshot(LiveDoc,api.conversationId,context);
        await record(run.id,{event:'tool_round_finished',tool_rounds:live?.run?.turns || 0});
      },
    })],
  };
}

export function timingSnapshot(value, settled = false) {
  if (!value) return undefined;
  const result = JSON.parse(JSON.stringify(value));
  if (settled) for (const entry of result.models) if (entry.status === 'running') entry.status = 'interrupted';
  result.incomplete_model_requests = Math.max(0,result.model_requests-result.model_responses);
  return result;
}
