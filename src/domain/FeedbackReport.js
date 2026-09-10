/**
 * FeedbackReport — the explainable output of an evaluation run.
 *
 * Design intent: a report must be **useful without being trusted**. Every
 * automated finding carries `evidence` (a quote from the learner's own
 * submission or the problem statement), and every dimension shows its score
 * AND the findings that produced it. Learners can audit why they lost points.
 *
 * Structure:
 *   - dimensions:  one entry per rubric dimension { key, label, weight,
 *                  score, maxScore, verdict, findings[] }
 *   - coverage:    requirement-by-requirement checklist with evidence
 *   - strengths:   short strings worth keeping
 *   - improvements: short, actionable next steps
 *   - llm:         provenance block — did an LLM contribute, which model,
 *                  or why not (never silently)
 */
export class FeedbackReport {
  /**
   * @param {object} r
   * @param {string} r.id
   * @param {string} r.attemptId
   * @param {string} r.problemId
   * @param {'deterministic'|'deterministic+llm-augmented'} r.engine
   * @param {number} r.overallScore           - 0..100
   * @param {Array} r.dimensions
   * @param {Array} r.coverage
   * @param {string[]} r.strengths
   * @param {string[]} r.improvements
   * @param {{used:boolean, model?:string, summary?:string, strengths?:string[],
   *          improvements?:string[], dimensionNotes?:object, reason?:string,
   *          error?:string}} r.llm
   * @param {string} r.generatedAt
   */
  constructor({ id, attemptId, problemId, engine, overallScore, dimensions, coverage, strengths, improvements, llm, generatedAt }) {
    this.id = id;
    this.attemptId = attemptId;
    this.problemId = problemId;
    this.engine = engine;
    this.overallScore = overallScore;
    this.dimensions = dimensions;
    this.coverage = coverage;
    this.strengths = strengths;
    this.improvements = improvements;
    this.llm = llm ?? { used: false, reason: 'not-configured' };
    this.generatedAt = generatedAt;
  }

  static fromJSON(raw) {
    return new FeedbackReport(raw);
  }

  toJSON() {
    return {
      id: this.id,
      attemptId: this.attemptId,
      problemId: this.problemId,
      engine: this.engine,
      overallScore: this.overallScore,
      dimensions: this.dimensions,
      coverage: this.coverage,
      strengths: this.strengths,
      improvements: this.improvements,
      llm: this.llm,
      generatedAt: this.generatedAt,
    };
  }
}

/**
 * Verdict banding shared by the evaluator and the UI.
 * @param {number} score  0..100 (or 0..maxScore normalised)
 * @returns {'good'|'fair'|'weak'}
 */
export function verdictFor(score) {
  if (score >= 80) return 'good';
  if (score >= 50) return 'fair';
  return 'weak';
}
