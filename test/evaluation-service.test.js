import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Attempt } from '../src/domain/Attempt.js';
import { Submission } from '../src/domain/Submission.js';
import { Problem } from '../src/domain/Problem.js';
import { ProblemRepository } from '../src/repositories/ProblemRepository.js';
import { AttemptRepository, FeedbackRepository } from '../src/repositories/AttemptRepository.js';
import { EvaluationService } from '../src/evaluation/EvaluationService.js';
import { EvaluationEngine } from '../src/evaluation/EvaluationEngine.js';
import { FeedbackReport } from '../src/domain/FeedbackReport.js';

const PROBLEM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'problems');

/* ------------------------------------------------------------------ */
/* Test doubles                                                         */
/* ------------------------------------------------------------------ */

class StubEngine extends EvaluationEngine {
  /**
   * @param {Array<'ok'|'fail'>} script - consumed one per call; last entry repeats
   */
  constructor(script = ['ok']) {
    super();
    this.script = script;
    this.calls = 0;
    this.idGen = (n) => `fb-${n}-${++this.calls}`;
  }
  async evaluate(attempt, problem) {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    if (step === 'fail') throw new Error(`engine failure #${this.calls}`);
    return new FeedbackReport({
      id: `fb-${attempt.id}-${this.calls}`,
      attemptId: attempt.id,
      problemId: problem.id,
      engine: 'deterministic',
      overallScore: 70,
      dimensions: [{ key: 'requirement-coverage', label: 'Coverage', weight: 100, score: 70, maxScore: 100, verdict: 'fair', findings: [] }],
      coverage: [],
      strengths: [],
      improvements: [],
      llm: { used: false, reason: 'not-configured' },
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
  }
}

class SlowEngine extends EvaluationEngine {
  constructor(ms) { super(); this.ms = ms; }
  async evaluate() { await new Promise((r) => setTimeout(r, this.ms)); throw new Error('slow engine finished too late anyway'); }
}

const silentLogger = { info() {}, warn() {}, error() {} };

const submissionPayload = {
  classes: [{ name: 'A', responsibilities: ['does a'], collaborators: [] }],
  relationships: [],
  rationale: 'r'.repeat(120),
};

async function freshStores() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'lld-store-'));
  const problemRepository = new ProblemRepository(PROBLEM_DIR);
  await problemRepository.loadSeeds();
  return {
    dir,
    attemptRepository: new AttemptRepository(join(dir, 'attempts.json')),
    feedbackRepository: new FeedbackRepository(join(dir, 'feedback.json')),
    problemRepository,
  };
}

async function submittedAttempt(attemptRepository, { problemId = 'parking-lot' } = {}) {
  const attempt = await attemptRepository.create({ problemId, learnerId: 'test-learner' });
  attempt.saveDraft(Submission.fromJSON(submissionPayload));
  attempt.submit();
  return attempt;
}

/* ------------------------------------------------------------------ */
/* EvaluationService behaviour                                          */
/* ------------------------------------------------------------------ */

describe('EvaluationService — the happy path', () => {
  let stores;
  beforeEach(async () => { stores = await freshStores(); });

  test('submitting schedules async evaluation: SUBMITTED -> EVALUATED with report persisted', async () => {
    const service = new EvaluationService(
      { engine: new StubEngine(['ok']), ...stores },
      { retries: 0, retryDelayMs: 10, logger: silentLogger }
    );
    const attempt = await submittedAttempt(stores.attemptRepository);
    await service.submitForEvaluation(attempt);
    await service.waitForIdle();

    const stored = await stores.attemptRepository.get(attempt.id);
    assert.equal(stored.status, 'EVALUATED');
    assert.ok(stored.feedbackId);
    const report = await stores.feedbackRepository.get(stored.feedbackId);
    assert.equal(report.attemptId, attempt.id);
    assert.equal(report.overallScore, 70);
  });

  test('history stays trustworthy: an EVALUATED attempt is not re-run', async () => {
    const service = new EvaluationService(
      { engine: new StubEngine(['ok']), ...stores },
      { retries: 0, logger: silentLogger }
    );
    const attempt = await submittedAttempt(stores.attemptRepository);
    await service.submitForEvaluation(attempt);
    await service.waitForIdle();

    const engine = service.engine;
    await service.enqueue(attempt.id, 0);
    await service.waitForIdle();
    assert.equal(engine.calls, 1, 'no second evaluation for an already-evaluated attempt');
  });
});

describe('EvaluationService — failure handling (assignment: "what if evaluation fails?")', () => {
  let stores;
  beforeEach(async () => { stores = await freshStores(); });

  test('engine failure with one retry: attempt recovers on the second call', async () => {
    const engine = new StubEngine(['fail', 'ok']); // fails once, then succeeds
    const service = new EvaluationService(
      { engine, ...stores },
      { retries: 1, retryDelayMs: 5, logger: silentLogger }
    );
    const attempt = await submittedAttempt(stores.attemptRepository);
    await service.submitForEvaluation(attempt);
    await service.waitForIdle();

    const stored = await stores.attemptRepository.get(attempt.id);
    assert.equal(stored.status, 'EVALUATED');
    assert.equal(engine.calls, 2);
  });

  test('persistent engine failure: attempt becomes FAILED with the reason, answer intact', async () => {
    const service = new EvaluationService(
      { engine: new StubEngine(['fail']), ...stores },
      { retries: 1, retryDelayMs: 5, logger: silentLogger }
    );
    const attempt = await submittedAttempt(stores.attemptRepository);
    await service.submitForEvaluation(attempt);
    await service.waitForIdle();

    const stored = await stores.attemptRepository.get(attempt.id);
    assert.equal(stored.status, 'FAILED');
    assert.match(stored.evaluationError, /engine failure/);
    assert.ok(stored.submission, 'the learner submission is still there');
  });

  test('FAILED attempt can be re-evaluated later (infrastructure failure is recoverable)', async () => {
    const engine = new StubEngine(['fail', 'ok']);
    const service = new EvaluationService(
      { engine, ...stores },
      { retries: 0, retryDelayMs: 5, logger: silentLogger }
    );
    const attempt = await submittedAttempt(stores.attemptRepository);
    await service.submitForEvaluation(attempt);
    await service.waitForIdle();
    assert.equal((await stores.attemptRepository.get(attempt.id)).status, 'FAILED');

    const stored = await stores.attemptRepository.get(attempt.id);
    await service.retryEvaluation(stored); // service owns the FAILED -> EVALUATING transition
    await service.waitForIdle();

    const after = await stores.attemptRepository.get(attempt.id);
    assert.equal(after.status, 'EVALUATED');
    assert.equal(after.evaluationError, null);
  });

  test('watchdog timeout: a hung engine cannot wedge the attempt forever', async () => {
    const service = new EvaluationService(
      { engine: new SlowEngine(2000), ...stores },
      { retries: 0, timeoutMs: 80, logger: silentLogger }
    );
    const attempt = await submittedAttempt(stores.attemptRepository);
    await service.submitForEvaluation(attempt);
    await service.waitForIdle();

    const stored = await stores.attemptRepository.get(attempt.id);
    assert.equal(stored.status, 'FAILED');
    assert.match(stored.evaluationError, /timed out/);
  });

  test('unknown problem at evaluation time: FAILED with a clear message', async () => {
    const service = new EvaluationService(
      { engine: new StubEngine(['ok']), ...stores },
      { retries: 0, logger: silentLogger }
    );
    const attempt = await submittedAttempt(stores.attemptRepository, { problemId: 'no-such-problem' });
    await service.submitForEvaluation(attempt);
    await service.waitForIdle();

    const stored = await stores.attemptRepository.get(attempt.id);
    assert.equal(stored.status, 'FAILED');
    assert.match(stored.evaluationError, /no longer available/);
  });

  test('submitForEvaluation refuses attempts that are not SUBMITTED', async () => {
    const service = new EvaluationService(
      { engine: new StubEngine(['ok']), ...stores },
      { logger: silentLogger }
    );
    const draft = await stores.attemptRepository.create({ problemId: 'parking-lot', learnerId: 'l' });
    await assert.rejects(() => service.submitForEvaluation(draft), /SUBMITTED/);
  });
});

describe('EvaluationService — concurrency control', () => {
  test('jobs beyond maxConcurrent wait in the queue (no queue infra needed)', async () => {
    const stores = await freshStores();
    let running = 0;
    let peak = 0;
    class TrackingEngine extends StubEngine {
      async evaluate(attempt, problem) {
        running++; peak = Math.max(peak, running);
        const report = await super.evaluate(attempt, problem);
        running--;
        return report;
      }
    }
    const service = new EvaluationService(
      { engine: new TrackingEngine(['ok']), ...stores },
      { retries: 0, maxConcurrent: 2, logger: silentLogger }
    );
    const attempts = [];
    for (let i = 0; i < 5; i++) attempts.push(await submittedAttempt(stores.attemptRepository));
    for (const a of attempts) await service.submitForEvaluation(a);
    await service.waitForIdle();

    assert.ok(peak <= 2, `concurrency cap respected (peak ${peak})`);
    for (const a of attempts) {
      assert.equal((await stores.attemptRepository.get(a.id)).status, 'EVALUATED');
    }
  });
});

/* ------------------------------------------------------------------ */
/* Repositories                                                         */
/* ------------------------------------------------------------------ */

describe('repositories', () => {
  test('attempt store roundtrips through disk: a new repository sees saved state', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'lld-repo-'));
    const repo = new AttemptRepository(join(dir, 'attempts.json'));
    const attempt = await repo.create({ problemId: 'parking-lot', learnerId: 'learner-9' });
    attempt.saveDraft(Submission.fromJSON(submissionPayload));
    attempt.submit();
    await repo.save(attempt);

    const reborn = new AttemptRepository(join(dir, 'attempts.json'));
    const restored = await reborn.get(attempt.id);
    assert.equal(restored.status, 'SUBMITTED');
    assert.equal(restored.submission.classes[0].name, 'A');
    assert.equal(restored.learnerId, 'learner-9');

    const history = await reborn.listByLearner('learner-9');
    assert.equal(history.length, 1);
  });

  test('problem repository loads and validates the real seed files', async () => {
    const repo = new ProblemRepository(PROBLEM_DIR);
    const count = await repo.loadSeeds();
    assert.equal(count, 3);
    for (const id of ['parking-lot', 'vending-machine', 'elevator-system']) {
      const problem = repo.get(id);
      assert.ok(problem, `${id} present`);
      assert.ok(problem.requirements.length >= 5);
      assert.equal(problem.totalRubricWeight, 100);
    }
    assert.equal(repo.get('missing'), null);
  });

  test('missing seed directory fails loudly at boot (curriculum errors are fatal)', async () => {
    const repo = new ProblemRepository(join(tmpdir(), 'definitely-not-here'));
    await assert.rejects(() => repo.loadSeeds(), /could not be read|No problem seed files/);
  });

  test('feedback repository: save, get by id, get by attempt id', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'lld-fb-'));
    const repo = new FeedbackRepository(join(dir, 'feedback.json'));
    const report = new FeedbackReport({
      id: 'fb-x', attemptId: 'att-x', problemId: 'parking-lot', engine: 'deterministic',
      overallScore: 50, dimensions: [], coverage: [], strengths: [], improvements: [],
      llm: { used: false }, generatedAt: '2026-01-01T00:00:00.000Z',
    });
    await repo.save(report);
    assert.equal((await repo.get('fb-x')).overallScore, 50);
    assert.equal((await repo.getByAttemptId('att-x')).id, 'fb-x');
    assert.equal(await repo.getByAttemptId('att-other'), null);
  });
});
