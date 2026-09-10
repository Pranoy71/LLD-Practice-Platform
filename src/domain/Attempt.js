import { InvalidTransitionError } from './errors.js';
import { Submission } from './Submission.js';

/**
 * Attempt lifecycle:
 *
 *   DRAFT ──submit()──▶ SUBMITTED ──▶ EVALUATING ──▶ EVALUATED
 *                          ▲               │
 *                          │            (engine
 *                          │             fails)
 *   FAILED ◀──retry── (re-queue) ◀───────┘
 *      │
 *      └──reevaluate()──▶ EVALUATING
 *
 * Rules that matter for product behaviour:
 *  - Only DRAFT attempts can be edited. Once submitted, the answer is
 *    immutable — history must stay trustworthy, so "try again" means a NEW
 *    attempt, not mutating an old one.
 *  - FAILED is recoverable: evaluation infrastructure failed, the learner's
 *    answer did not. Retrying re-runs the same submission.
 *  - EVALUATED is terminal (the report is attached forever).
 */
export const AttemptStatus = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  EVALUATING: 'EVALUATING',
  EVALUATED: 'EVALUATED',
  FAILED: 'FAILED',
});

const TRANSITIONS = Object.freeze({
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['EVALUATING'],
  EVALUATING: ['EVALUATED', 'FAILED'],
  EVALUATED: [],
  FAILED: ['EVALUATING'],
});

/**
 * Attempt — the aggregate root of the practice loop.
 *
 * Owns: identity, the submission (once set), the status machine and the
 * timestamps that make attempt history meaningful.
 * Does NOT own: evaluation logic (see src/evaluation/*) or persistence
 * (see src/repositories/*).
 *
 * @class Attempt
 */
export class Attempt {
  /**
   * @param {object} a
   * @param {string} a.id
   * @param {string} a.problemId
   * @param {string} a.learnerId
   * @param {string} a.status
   * @param {Submission|null} a.submission
   * @param {string|null} a.feedbackId
   * @param {string|null} a.evaluationError
   * @param {string} a.createdAt
   * @param {string} a.updatedAt
   * @param {string|null} a.submittedAt
   * @param {string|null} a.evaluatedAt
   */
  constructor({ id, problemId, learnerId, status, submission, feedbackId, evaluationError, createdAt, updatedAt, submittedAt, evaluatedAt }) {
    this.id = id;
    this.problemId = problemId;
    this.learnerId = learnerId;
    this.status = status;
    /** @type {Submission|null} */
    this.submission = submission ?? null;
    this.feedbackId = feedbackId ?? null;
    this.evaluationError = evaluationError ?? null;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.submittedAt = submittedAt ?? null;
    this.evaluatedAt = evaluatedAt ?? null;
  }

  /** Factory for a fresh attempt. State starts at DRAFT. */
  static start({ id, problemId, learnerId, now = () => new Date().toISOString() }) {
    const ts = now();
    return new Attempt({
      id,
      problemId,
      learnerId,
      status: AttemptStatus.DRAFT,
      submission: null,
      feedbackId: null,
      evaluationError: null,
      createdAt: ts,
      updatedAt: ts,
    });
  }

  /** Rehydrate from persistence. */
  static fromJSON(raw) {
    return new Attempt({
      id: raw.id,
      problemId: raw.problemId,
      learnerId: raw.learnerId,
      status: raw.status,
      submission: raw.submission ? new Submission(raw.submission) : null,
      feedbackId: raw.feedbackId,
      evaluationError: raw.evaluationError,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      submittedAt: raw.submittedAt,
      evaluatedAt: raw.evaluatedAt,
    });
  }

  /**
   * Attach or replace the draft submission. DRAFT-only by design.
   * @param {Submission} submission
   */
  saveDraft(submission, now = () => new Date().toISOString()) {
    this.assertCanTransition(AttemptStatus.DRAFT);
    this.submission = submission;
    this.updatedAt = now();
  }

  /** Lock the answer in and move to SUBMITTED. */
  submit(now = () => new Date().toISOString()) {
    this.assertCanTransition(AttemptStatus.SUBMITTED);
    if (!this.submission) {
      throw new InvalidTransitionError(this.status, 'SUBMITTED with no submission');
    }
    this.status = AttemptStatus.SUBMITTED;
    this.submittedAt = now();
    this.updatedAt = this.submittedAt;
  }

  /** Mark that an evaluation run has picked the attempt up. */
  markEvaluating(now = () => new Date().toISOString()) {
    this.assertCanTransition(AttemptStatus.EVALUATING);
    this.status = AttemptStatus.EVALUATING;
    this.evaluationError = null;
    this.updatedAt = now();
  }

  /** Attach the finished report. Terminal success state. */
  markEvaluated(feedbackId, now = () => new Date().toISOString()) {
    this.assertCanTransition(AttemptStatus.EVALUATED);
    this.status = AttemptStatus.EVALUATED;
    this.feedbackId = feedbackId;
    this.evaluatedAt = now();
    this.updatedAt = this.evaluatedAt;
  }

  /** Record an evaluation-infrastructure failure (recoverable). */
  markFailed(reason, now = () => new Date().toISOString()) {
    this.assertCanTransition(AttemptStatus.FAILED);
    this.status = AttemptStatus.FAILED;
    this.evaluationError = String(reason).slice(0, 500);
    this.updatedAt = now();
  }

  /** Is this attempt open for re-running evaluation? */
  get canRetryEvaluation() {
    return this.status === AttemptStatus.FAILED;
  }

  /** May the learner still edit the submission? */
  get isEditable() {
    return this.status === AttemptStatus.DRAFT;
  }

  assertCanTransition(to) {
    if (this.status === to) return; // idempotent state writes
    if (!TRANSITIONS[this.status]?.includes(to)) {
      throw new InvalidTransitionError(this.status, to);
    }
  }

  /** Projection used by API responses and persistence. */
  toJSON() {
    return {
      id: this.id,
      problemId: this.problemId,
      learnerId: this.learnerId,
      status: this.status,
      submission: this.submission ? this.submission.toJSON() : null,
      feedbackId: this.feedbackId,
      evaluationError: this.evaluationError,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      submittedAt: this.submittedAt,
      evaluatedAt: this.evaluatedAt,
    };
  }
}
