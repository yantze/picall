import { appError } from './config.js';

/** Validate history with platform-supplied hashes, preserving each existing hash algorithm. */
export function continueHistory(input, previous, prefixHashes = []) {
  const system = input.system ?? previous?.system ?? '';
  let messages = input.messages;
  const count = previous?.count ?? previous?.hashes?.length ?? 0;
  if (count) {
    if (system !== previous.system || input.model.replace(/^picall\//, '') !== previous.model.replace(/^picall\//, '')) {
      throw appError('Session instructions or model changed. Start a new session.', 409, 'session_configuration_changed');
    }
    if (messages.length > 1) {
      if (messages.length !== count + 1 || JSON.stringify(prefixHashes) !== JSON.stringify(previous.hashes)) {
        throw appError('Session history does not match.', 409, 'session_history_conflict');
      }
      messages = messages.slice(-1);
    }
  }
  return { system, messages };
}
