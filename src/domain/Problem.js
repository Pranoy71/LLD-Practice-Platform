import { ValidationError } from './errors.js';

/** Difficulty is a closed vocabulary so the UI and filters stay consistent. */
export const DIFFICULTIES = Object.freeze(['EASY', 'MEDIUM', 'HARD']);

/**
 * Problem — a practice LLD exercise.
 *
 * A Problem owns everything an evaluator needs to reason about a submission:
 *  - `requirements`: observable behaviours the learner's design must account
 *    for. Each requirement carries `keywords` (with synonyms) used by the
 *    deterministic coverage check.
 *  - `rubric`: weighted dimensions. Weights are data, not code, so a future
 *    problem can emphasise different dimensions without touching the engine.
 *
 * @class Problem
 */
export class Problem {
  /**
   * @param {object} p
   * @param {string} p.id          - stable identifier (also used in URLs)
   * @param {string} p.title
   * @param {'EASY'|'MEDIUM'|'HARD'} p.difficulty
   * @param {string} p.statement   - full problem statement (markdown-ish text)
   * @param {string} p.context     - extra background ("interview framing")
   * @param {Array<{id:string,text:string,keywords:string[]}>} p.requirements
   * @param {Array<{key:string,label:string,weight:number,hint:string}>} p.rubric
   * @param {string[]} p.thinkingHints - nudges shown before starting
   * @param {number} [p.timeboxMinutes] - suggested time budget
   */
  constructor({ id, title, difficulty, statement, context, requirements, rubric, thinkingHints, timeboxMinutes }) {
    this.id = id;
    this.title = title;
    this.difficulty = difficulty;
    this.statement = statement;
    this.context = context;
    this.requirements = requirements;
    this.rubric = rubric;
    this.thinkingHints = thinkingHints;
    this.timeboxMinutes = timeboxMinutes ?? 45;
    this.createdAt = new Date().toISOString();
  }

  /** Sum of rubric weights — used to sanity-check the seed data. */
  get totalRubricWeight() {
    return this.rubric.reduce((sum, r) => sum + r.weight, 0);
  }

  /**
   * Build a Problem from raw JSON (seed file or API payload).
   * Validation lives here so malformed seed files fail loudly at boot.
   *
   * @param {object} raw
   * @returns {Problem}
   * @throws {ValidationError}
   */
  static fromJSON(raw) {
    if (!raw || typeof raw !== 'object') throw new ValidationError('Problem payload must be an object.');
    const required = ['id', 'title', 'difficulty', 'statement', 'requirements', 'rubric'];
    for (const field of required) {
      if (!raw[field]) throw new ValidationError(`Problem is missing required field '${field}'.`);
    }
    if (!DIFFICULTIES.includes(raw.difficulty)) {
      throw new ValidationError(`Problem difficulty must be one of ${DIFFICULTIES.join(', ')}.`);
    }
    if (!Array.isArray(raw.requirements) || raw.requirements.length === 0) {
      throw new ValidationError(`Problem '${raw.id}' must declare at least one requirement.`);
    }
    raw.requirements.forEach((r, i) => {
      if (!r.id || !r.text || !Array.isArray(r.keywords) || r.keywords.length === 0) {
        throw new ValidationError(`Problem '${raw.id}' requirement #${i + 1} needs id, text and at least one keyword.`);
      }
    });
    if (!Array.isArray(raw.rubric) || raw.rubric.length === 0) {
      throw new ValidationError(`Problem '${raw.id}' must declare a rubric.`);
    }
    const total = raw.rubric.reduce((s, r) => s + (Number(r.weight) || 0), 0);
    if (Math.abs(total - 100) > 0.001) {
      throw new ValidationError(`Problem '${raw.id}' rubric weights must sum to 100 (got ${total}).`);
    }

    return new Problem({
      id: raw.id,
      title: raw.title,
      difficulty: raw.difficulty,
      statement: raw.statement,
      context: raw.context ?? '',
      requirements: raw.requirements,
      rubric: raw.rubric,
      thinkingHints: raw.thinkingHints ?? [],
      timeboxMinutes: raw.timeboxMinutes,
    });
  }

  /** API-safe projection (seeds are read-only, so this is the full entity). */
  toJSON() {
    return {
      id: this.id,
      title: this.title,
      difficulty: this.difficulty,
      statement: this.statement,
      context: this.context,
      requirements: this.requirements,
      rubric: this.rubric,
      thinkingHints: this.thinkingHints,
      timeboxMinutes: this.timeboxMinutes,
    };
  }
}
