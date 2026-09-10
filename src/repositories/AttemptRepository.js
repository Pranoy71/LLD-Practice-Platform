import { randomUUID } from 'node:crypto';
import { Attempt } from '../domain/Attempt.js';
import { JsonFileStore } from './JsonFileStore.js';
import { NotFoundError } from '../domain/errors.js';

/**
 * AttemptRepository — persistence for attempts.
 *
 * In-memory Map + write-through JSON file. Every mutation goes through
 * `save()`, which re-persists the full map (fine for MVP scale; the
 * interface is what matters — see Design Note § extensibility).
 *
 * @class AttemptRepository
 */
export class AttemptRepository {
  /**
   * @param {string} storeFilePath - e.g. <data>/store/attempts.json
   */
  constructor(storeFilePath) {
    /** @type {Map<string, Attempt>} */
    this.attempts = new Map();
    this.store = new JsonFileStore(storeFilePath);
    this.hydrate();
  }

  /** Rebuild in-memory state from the last persisted snapshot. */
  hydrate() {
    const persisted = this.store.data;
    if (!Array.isArray(persisted)) return;
    for (const raw of persisted) {
      const attempt = Attempt.fromJSON(raw);
      this.attempts.set(attempt.id, attempt);
    }
  }

  /**
   * Create and persist a fresh DRAFT attempt.
   * @param {{problemId: string, learnerId: string}} input
   * @returns {Promise<Attempt>}
   */
  async create({ problemId, learnerId }) {
    const attempt = Attempt.start({
      id: `att-${randomUUID().slice(0, 8)}`,
      problemId,
      learnerId,
    });
    return this.save(attempt);
  }

  /**
   * Persist an attempt (any state) and return it.
   * @param {Attempt} attempt
   */
  async save(attempt) {
    this.attempts.set(attempt.id, attempt);
    await this.store.save([...this.attempts.values()].map((a) => a.toJSON()));
    return attempt;
  }

  /** Serializable snapshot of all attempts (order: insertion order of the map). */
  toJSONArray() {
    return [...this.attempts.values()].map((a) => a.toJSON());
  }

  /**
   * @param {string} id
   * @returns {Promise<Attempt|null>}
   */
  async get(id) {
    return this.attempts.get(id) ?? null;
  }

  /** Fetch or throw (controller convenience). */
  async getOrThrow(id) {
    const attempt = await this.get(id);
    if (!attempt) throw new NotFoundError('Attempt', id);
    return attempt;
  }

  /**
   * Attempt history for a learner, newest first.
   * @param {string} learnerId
   * @param {{problemId?: string}} [filter]
   * @returns {Promise<Attempt[]>}
   */
  async listByLearner(learnerId, { problemId } = {}) {
    return [...this.attempts.values()]
      .filter((a) => a.learnerId === learnerId && (!problemId || a.problemId === problemId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/**
 * FeedbackRepository — persistence for feedback reports.
 *
 * Kept separate from attempts on purpose: a report is immutable once
 * written, is keyed by its own id, and is looked up independently of the
 * attempt lifecycle. (Also: one attempt = at most one report in the MVP.)
 *
 * @class FeedbackRepository
 */
export class FeedbackRepository {
  /**
   * @param {string} storeFilePath - e.g. <data>/store/feedback.json
   */
  constructor(storeFilePath) {
    /** @type {Map<string, object>} plain report JSON keyed by id */
    this.reports = new Map();
    this.store = new JsonFileStore(storeFilePath);
    const persisted = this.store.data;
    if (Array.isArray(persisted)) {
      for (const raw of persisted) this.reports.set(raw.id, raw);
    }
  }

  /** @param {import('../domain/FeedbackReport.js').FeedbackReport} report */
  async save(report) {
    this.reports.set(report.id, report.toJSON());
    await this.store.save([...this.reports.values()]);
    return report;
  }

  /** @param {string} id */
  async get(id) {
    return this.reports.get(id) ?? null;
  }

  /** @param {string} attemptId */
  async getByAttemptId(attemptId) {
    for (const report of this.reports.values()) {
      if (report.attemptId === attemptId) return report;
    }
    return null;
  }
}
