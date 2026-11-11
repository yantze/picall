export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface TaskError { code: string; status: number; message: string }
export interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number; models: Record<string, unknown> }
export interface Completion {
  id: string; object: 'chat.completion'; created: number; model: string;
  choices: { index: number; message: { role: 'assistant'; content: string }; finish_reason: 'stop' }[];
  usage: Usage;
}
export interface ResearchRun {
  id: string; sessionId: string; status: RunStatus; model: string;
  createdAt: number; updatedAt: number; completion?: Completion; error?: TaskError;
  usage?: Usage; elapsed_ms?: number; service_calls?: Record<string, number>;
  timings?: RunTimings;
}
export interface TimedRequests { completed_requests:number; errors:number; elapsed_ms:number; headers_ms?:number; cache_hits?:number }
export interface RunTimings {
  version:1; model_requests:number; model_responses:number; model_ms:number; tool_rounds:number;
  hard_limit?:number; budget_reminders?:boolean; incomplete_model_requests:number;
  models:{id:string;request:number;tool_rounds_before_request:number;sdk_attempt:number;startedAt:number;status:string;elapsed_ms?:number;usage?:Record<string,number>}[];
  tools:Record<string,TimedRequests>; providers:Record<string,TimedRequests>;
}
export interface RunScope { id: string; deadline: number }
export interface ResearchStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}
export interface AdmissionOptions { sessionId?: string; idempotencyKey?: string; identityInput?: unknown }
export interface ResearchRuntime {
  lookup(input: unknown, options?: AdmissionOptions): Promise<ResearchRun | undefined>;
  submit(input: unknown, options?: AdmissionOptions): Promise<ResearchRun>;
  get(id: string): Promise<ResearchRun>;
  wait(id: string, options?: { signal?: AbortSignal }): Promise<ResearchRun>;
  cancel(id: string): Promise<ResearchRun>;
}
