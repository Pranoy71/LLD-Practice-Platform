/**
 * EvaluationService — the orchestrator that owns the *process* of evaluation.
 *
 * Engines stay dumb (pure evaluation); this service owns everything the
 * assignment's "what if evaluation takes time or fails?" question asks about:
 *
 *   - async execution: submit returns immediately; the UI polls attempt status
 *   - watchdog: one overall timeout per run (default 30s), so a hung LLM call
 *     cannot wedge an attempt in EVALUATING forever
 *   - bounded retry: one retry (configurable) before giving up
 *   - failure states: FAILED is an *infrastructure* failure with a message,
 *     recoverable via retryEvaluation() — the learner's answer is intact
 *   - concurrency cap: at most N evaluations in flight (default 2); excess
 *     jobs queue in-process. A monolith-appropriate answer — no queue
 *     infrastructure, but the seam for a real worker exists.
 *
 * @class EvaluationService
 */
export class EvaluationService {
  /**
   * @param {object} deps
   * @param {import('./EvaluationEngine.js').EvaluationEngine} deps.engine
   * @param {import('../repositories/AttemptRepository.js').AttemptRepository} deps.attemptRepository
   * @param {import('../repositories/FeedbackRepository.js').FeedbackRepository} deps.feedbackRepository
   * @param {import('../repositories/ProblemRepository.js').ProblemRepository} deps.problemRepository
   * @param {object} [options]
   * @param {number} [options.retries=1]
   * @param {number} [options.timeoutMs=30000]
   * @param {number} [options.maxConcurrent=2]
   * @param {number} [options.retryDelayMs=400]
   * @param {{info:Function,warn:Function,error:Function}} [options.logger]
   */
  constructor({ engine, attemptRepository, feedbackRepository, problemRepository }, options = {}) {
    this.engine = engine;
    this.attemptRepository = attemptRepository;
    this.feedbackRepository = feedbackRepository;
    this.problemRepository = problemRepository;
    this.retries = options.retries ?? 1;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 400;
    this.logger = options.logger ?? console;

    /** @type {Array<{attemptId: string, retriesLeft: number}>} */
    this.queue = [];
    this.active = 0;
    this.scheduled = new Set();
    this.idleResolvers = [];
  }

  /**
   * Entry point used right after an attempt is submitted. Schedules the
   * evaluation and resolves immediately — the caller (HTTP layer) must not
   * wait for evaluation to finish.
   *
   * @param {import('../domain/Attempt.js').Attempt} attempt
   */
  async submitForEvaluation(attempt) {
    if (attempt.status !== 'SUBMITTED') {
      throw new Error(`Expected attempt to be SUBMITTED before scheduling evaluation (got ${attempt.status}).`);
    }
    await this.attemptRepository.save(attempt);
    this.enqueue(attempt.id, this.retries);
  }

  /**
   * Recover a FAILED attempt by re-running evaluation on the stored answer.
   * Owns the FAILED -> EVALUATING transition so callers can't get it wrong.
   * @param {import('../domain/Attempt.js').Attempt} attempt
   */
  async retryEvaluation(attempt) {
    if (!attempt.canRetryEvaluation) {
      throw new Error('Only FAILED attempts can be re-evaluated.');
    }
    attempt.markEvaluating();
    await this.attemptRepository.save(attempt);
    this.enqueue(attempt.id, this.retries);
  }

  /** Queue a job unless one is already scheduled for the same attempt. */
  enqueue(attemptId, retriesLeft) {
    if (this.scheduled.has(attemptId)) return;
    this.scheduled.add(attemptId);
    this.queue.push({ attemptId, retriesLeft });
    this.pump();
  }

  /** Start queued jobs while below the concurrency cap. */
  pump() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active++;
      this.run(job)
        .catch((err) => this.logger.error?.(`evaluation job crashed: ${err?.message ?? err}`))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
    if (this.active === 0 && this.queue.length === 0) {
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      resolvers.forEach((resolve) => resolve());
    }
  }

  /** Resolves when no evaluation is queued or in flight (tests + shutdown). */
  async waitForIdle() {
    if (this.active === 0 && this.queue.length === 0) return;
    await new Promise((resolve) => this.idleResolvers.push(resolve));
    return this.waitForIdle();
  }

  /**
   * One evaluation run for one attempt, including state transitions.
   * ALL failure paths funnel through the catch below, so an attempt can
   * never be left dangling in SUBMITTED/EVALUATING.
   * @param {{attemptId: string, retriesLeft: number}} job
   */
  async run({ attemptId, retriesLeft }) {
    const attempt = await this.attemptRepository.get(attemptId);
    if (!attempt) {
      this.scheduled.delete(attemptId);
      return; // vanished (e.g. store reset) — nothing sensible to do
    }
    if (attempt.status === 'EVALUATED') {
      this.scheduled.delete(attemptId);
      return; // idempotent guard
    }

    try {
      // SUBMITTED -> EVALUATING (also FAILED -> EVALUATING on retry)
      if (attempt.status === 'SUBMITTED' || attempt.status === 'FAILED') {
        attempt.markEvaluating();
        await this.attemptRepository.save(attempt);
      }

      const problem = this.problemRepository.get(attempt.problemId);
      if (!problem) {
        throw new Error(`Problem '${attempt.problemId}' is no longer available; cannot evaluate.`);
      }

      const report = await withTimeout(this.engine.evaluate(attempt, problem), this.timeoutMs);
      if (!isValidReport(report, attempt)) {
        throw new Error('Engine returned an invalid report.');
      }
      attempt.markEvaluated(report.id);
      await this.feedbackRepository.save(report);
      await this.attemptRepository.save(attempt);
      this.logger.info?.(`evaluated attempt ${attemptId}: score ${report.overallScore}`);
    } catch (error) {
      if (retriesLeft > 0) {
        this.logger.warn?.(`evaluation of ${attemptId} failed (${errorMessage(error)}); retrying...`);
        await delay(this.retryDelayMs);
        // attempt stays EVALUATING; retry the engine directly with one less retry
        await this.run({ attemptId, retriesLeft: retriesLeft - 1 });
        return;
      }
      try {
        attempt.markFailed(errorMessage(error));
      } catch (transitionError) {
        // Only reachable if the attempt was mutated concurrently; last resort.
        attempt.status = 'FAILED';
        attempt.evaluationError = errorMessage(error);
      }
      await this.attemptRepository.save(attempt);
      this.logger.error?.(`evaluation of ${attemptId} failed permanently: ${errorMessage(error)}`);
    } finally {
      this.scheduled.delete(attemptId);
    }
  }
}

function isValidReport(report, attempt) {
  return Boolean(
    report &&
    report.id &&
    report.attemptId === attempt.id &&
    Array.isArray(report.dimensions) &&
    report.dimensions.length > 0 &&
    typeof report.overallScore === 'number'
  );
}

function errorMessage(error) {
  const message = error?.message ?? String(error);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Overall watchdog — a hung engine cannot wedge an attempt forever. */
function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Evaluation timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
