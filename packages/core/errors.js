export const RUN_ERRORS = Object.freeze({
  request_cancelled: [499, 'The task was cancelled.'],
  request_timeout: [504, 'The task exceeded its original execution deadline.'],
  session_configuration_changed: [409, 'Execution configuration changed. Submit a new task with a new session.'],
  provider_error: [502, 'The model provider rejected or failed the request.'],
  turn_limit: [422, 'The task reached its tool-round limit.'],
  output_limit: [502, 'The model exhausted its output limit before completing an answer.'],
  unanswered: [502, 'The task ended without a completed answer.'],
  restart_limit: [502, 'The task exceeded its crash recovery limit.'],
  storage_error: [507, 'Task storage is unavailable.'],
  process_interrupted: [502, 'The legacy task cannot resume under the new runtime. Submit a new task.'],
});
export function runFailure(code) {
  const [status, message] = RUN_ERRORS[code] || [502, 'The task failed. Check operational logs.'];
  return { code, status, message };
}
export function errorEnvelope(error) {
  const status = error.status || 502;
  return { error: { message: error.code ? error.message || error.code : 'Internal service error. See operational logs.',
    type: status === 401 ? 'authentication_error' : status < 500 ? 'invalid_request_error' : 'api_error',
    param: error.param ?? null, code: error.code || 'internal_error' } };
}
