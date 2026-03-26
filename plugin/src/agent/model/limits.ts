/**
 * The agent is designed to handle multi-step workflows (chained searches,
 * search-then-import-then-move, etc.) so we give it generous limits by
 * default.  Bulk operations that touch many items still get a higher cap.
 */
export const MAX_AGENT_ROUNDS = 24;
export const MAX_AGENT_TOOL_CALLS_PER_ROUND = 8;

export const MAX_BULK_AGENT_ROUNDS = 32;
export const MAX_BULK_TOOL_CALLS_PER_ROUND = 10;

export function resolveAgentLimits(isBulkOperation: boolean): {
  maxRounds: number;
  maxToolCallsPerRound: number;
} {
  if (isBulkOperation) {
    return {
      maxRounds: MAX_BULK_AGENT_ROUNDS,
      maxToolCallsPerRound: MAX_BULK_TOOL_CALLS_PER_ROUND,
    };
  }
  return {
    maxRounds: MAX_AGENT_ROUNDS,
    maxToolCallsPerRound: MAX_AGENT_TOOL_CALLS_PER_ROUND,
  };
}
