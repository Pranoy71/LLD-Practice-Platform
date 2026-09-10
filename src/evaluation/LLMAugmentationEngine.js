import { EvaluationEngine } from './EvaluationEngine.js';

/**
 * LLMAugmentationEngine — decorator over a deterministic engine.
 *
 * Answers the assignment question "which parts benefit from an LLM?":
 * deterministic checks are reproducible but shallow; an LLM can reason about
 * design intent. So this engine ALWAYS runs the inner (deterministic) engine
 * first, then *tries* to enrich the report with LLM reasoning.
 *
 * Failure policy (assignment question: "what if evaluation takes time or
 * fails?"):
 *   - unconfigured client   → report ships as deterministic, llm.reason set
 *   - timeout / HTTP error  → same: the deterministic report is never lost
 *   - invalid LLM output    → same, llm.reason = 'invalid-response'
 *   - LLM is *advisory*: it can add notes, never change deterministic scores
 *     (trust + explainability: automated scoring stays reproducible)
 *
 * @class LLMAugmentationEngine
 * @extends EvaluationEngine
 */
export class LLMAugmentationEngine extends EvaluationEngine {
  /**
   * @param {object} deps
   * @param {EvaluationEngine} deps.inner        - deterministic baseline engine
   * @param {import('./LLMClient.js').LLMClient} deps.client
   * @param {number} [deps.timeoutMs]            - watchdog for the LLM call only
   * @param {() => string} [deps.now]
   */
  constructor({ inner, client, timeoutMs = 25000, now = () => new Date().toISOString() } = {}) {
    super();
    if (!inner) throw new Error('LLMAugmentationEngine requires an inner EvaluationEngine.');
    this.inner = inner;
    this.client = client;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  /**
   * @param {import('../domain/Attempt.js').Attempt} attempt
   * @param {import('../domain/Problem.js').Problem} problem
   * @returns {Promise<import('../domain/FeedbackReport.js').FeedbackReport>}
   */
  async evaluate(attempt, problem) {
    // 1) The deterministic baseline ALWAYS runs and ALWAYS survives.
    const report = await this.inner.evaluate(attempt, problem);
    report.llm = { used: false, reason: 'not-configured' };

    if (!this.client?.configured) return report;

    // 2) Advisory enrichment, best-effort.
    try {
      const payload = await withTimeout(
        this.client.completeJSON(buildSystemPrompt(), buildUserPrompt(attempt, problem, report)),
        this.timeoutMs
      );
      const notes = sanitizeLLMFeedback(payload);
      if (!notes) {
        report.llm = { used: false, reason: 'invalid-response', model: this.client.model };
        return report;
      }
      report.llm = {
        used: true,
        model: this.client.model,
        summary: notes.summary,
        strengths: notes.strengths,
        improvements: notes.improvements,
        dimensionNotes: notes.dimensionNotes,
        note: 'LLM commentary is advisory. Scores and coverage are produced by deterministic rules.',
      };
      report.engine = 'deterministic+llm-augmented';
    } catch (error) {
      report.llm = {
        used: false,
        reason: 'error',
        error: String(error?.message ?? error).slice(0, 300),
      };
    }
    return report;
  }
}

/* ------------------------------------------------------------------ */
/* Prompting                                                            */
/* ------------------------------------------------------------------ */

function buildSystemPrompt() {
  return [
    'You are a senior Low-Level Design reviewer giving feedback to a learner.',
    'The deterministic checks (scores, requirement coverage, structural findings) are already computed and given to you.',
    'Your job is the part rules cannot do: judge design intent, spot missing abstractions, and coach.',
    'Rules:',
    '- Be specific: reference the learner\'s actual class names.',
    '- Never invent requirements that are not in the problem statement.',
    '- There is no single correct design: critique trade-offs, not "the" answer.',
    '- Do NOT change or restate deterministic scores.',
    'Respond ONLY with a JSON object of shape:',
    '{"summary": string, "strengths": string[3], "improvements": string[3], "dimensionNotes": {"requirement-coverage": string, "class-design": string, "relationships": string, "rationale-and-tradeoffs": string, "extensibility": string}}',
  ].join('\n');
}

function buildUserPrompt(attempt, problem, report) {
  return JSON.stringify(
    {
      problem: {
        title: problem.title,
        statement: problem.statement,
        requirements: problem.requirements,
        rubric: problem.rubric,
      },
      learnerSubmission: attempt.submission.toJSON(),
      deterministicFindings: {
        overallScore: report.overallScore,
        coverage: report.coverage.map((c) => ({ requirement: short(c.text), level: c.level })),
        dimensions: report.dimensions.map((d) => ({
          dimension: d.key,
          score: d.score,
          findings: d.findings.map((f) => `${f.severity}: ${f.message}`),
        })),
      },
    },
    null,
    1
  );
}

/* ------------------------------------------------------------------ */
/* Response sanitisation — never trust the model blindly                */
/* ------------------------------------------------------------------ */

const MAX_LLM_STRING = 600;
const MAX_LLM_ITEMS = 4;
const DIMENSION_KEYS = [
  'requirement-coverage', 'class-design', 'relationships',
  'rationale-and-tradeoffs', 'extensibility',
];

/**
 * Validate/clip the LLM payload. Returns a clean object or null.
 * @param {object|null} payload
 */
function sanitizeLLMFeedback(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const summary = clip(payload.summary);
  if (!summary) return null;
  const strengths = clipArray(payload.strengths);
  const improvements = clipArray(payload.improvements);
  if (strengths.length === 0 && improvements.length === 0) return null;

  const dimensionNotes = {};
  if (payload.dimensionNotes && typeof payload.dimensionNotes === 'object') {
    for (const key of DIMENSION_KEYS) {
      const note = clip(payload.dimensionNotes[key]);
      if (note) dimensionNotes[key] = note;
    }
  }
  return { summary, strengths, improvements, dimensionNotes };
}

function clip(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_LLM_STRING ? trimmed.slice(0, MAX_LLM_STRING - 3) + '...' : trimmed;
}

function clipArray(value, cap = MAX_LLM_ITEMS) {
  if (!Array.isArray(value)) return [];
  return value.map(clip).filter(Boolean).slice(0, cap);
}

function short(text, max = 120) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

/** Race a promise against a timeout — rejects with a TimeoutError on expiry. */
function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM call timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
