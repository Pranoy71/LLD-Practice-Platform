/**
 * EvaluationEngine — the strategy interface every evaluator implements.
 *
 * Contract:
 *   - `evaluate(attempt, problem)` receives a SUBMITTED attempt and its
 *     problem, and resolves to a FeedbackReport.
 *   - Implementations MUST NOT mutate the attempt (state transitions belong
 *     to EvaluationService).
 *   - Implementations may be async (LLM calls) and should expect the caller
 *     to enforce an overall watchdog timeout.
 *   - Throwing is allowed: the service owns retries, fallback and failure
 *     states. This keeps engines dumb and testable.
 *
 * This seam is what makes the platform extensible: a future `CodeParsingEngine`
 * (compiles learner code, builds an AST) or `DiagramEngine` (parses a
 * PlantUML/Mermaid submission) plugs in without touching the service, the
 * repositories or the HTTP layer.
 */
export class EvaluationEngine {
  /**
   * @param {import('../domain/Attempt.js').Attempt} attempt
   * @param {import('../domain/Problem.js').Problem} problem
   * @returns {Promise<import('../domain/FeedbackReport.js').FeedbackReport>}
   */
  async evaluate(_attempt, _problem) {
    throw new Error('EvaluationEngine.evaluate() must be implemented by a concrete engine.');
  }
}
