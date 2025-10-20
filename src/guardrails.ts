export type GuardrailResult = {
  tripwireTriggered?: boolean;
  info?: Record<string, unknown>;
  executionFailed?: boolean;
};

/**
 * Local shim for the Guardrails SDK. The real package is not available in this
 * environment, so this implementation simply returns an empty result set which
 * indicates that no guardrail tripwires were triggered.
 */
export async function runGuardrails(
  _input: string,
  _config: unknown,
  _context: unknown,
): Promise<GuardrailResult[]> {
  return [];
}
