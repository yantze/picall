/** A planning target inside the durable hard limit, never a new run or deadline. */
export function researchBudget(rounds, hard, seconds, strategy = 'staged') {
  const prefix = `RESEARCH BUDGET: ${rounds}/${hard} tool rounds used; ${Math.max(0,hard-rounds)} remaining before the hard cutoff; ${seconds}s until the original deadline. A round reaching the hard limit ends without another answer request. `;
  if (strategy !== 'staged') return {text:prefix +
    'Once retrieved, dated evidence directly answers the question, give the final answer now. Use additional tools only for a specific missing, stale or conflicting fact. Preserve room to finish. Budget pressure never justifies inventing facts or citations; state evidence limitations honestly. Do not include this budget metadata in the final answer.'};
  // The SDK ends a run on the last tool round, before another answer request.
  const answerSafeLimit = Math.max(0, hard - 1);
  const initial = Math.min(2, answerSafeLimit);
  const phase = rounds >= answerSafeLimit ? 'finalize' : rounds >= initial ? 'extended' : 'initial';
  const target = phase === 'initial' ? initial : answerSafeLimit;
  const guidance = phase === 'initial'
    ? `Aim to finish within ${initial} tool rounds. This is a soft planning target, not a cutoff: gather only evidence needed for the requested answer. Batch independent lookups when their inputs are already known; never guess source URLs just to parallelize.`
    : phase === 'extended'
      ? `The initial ${initial}-round planning target has been reached. The single extension phase is available, within the existing limit of ${answerSafeLimit} answer-safe tool rounds. Continue only to resolve a specific missing, stale or conflicting fact; do not restart research or recheck facts already supported.`
      : 'No answer-safe tool rounds remain. Give the supported answer now, or clearly explain what could not be verified. Do not call another tool and lose the final answer to the hard cutoff.';
  const text = prefix +
    guidance + ' Before answering, check that retrieved evidence supports each requested claim and that timestamps/valid periods match any today/latest claim. Distinguish forecasts from observations and distinguish different meanings of ambiguous terms. Once evidence is sufficient, answer directly with citations, without optional side topics. Budget pressure never justifies inventing facts or citations; state evidence limitations honestly. Do not include this budget metadata in the final answer.';
  return { text, phase, initial, target };
}
