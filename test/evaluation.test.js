import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Attempt } from '../src/domain/Attempt.js';
import { Submission } from '../src/domain/Submission.js';
import { Problem } from '../src/domain/Problem.js';
import { RubricEvaluationEngine } from '../src/evaluation/RubricEvaluationEngine.js';
import { LLMAugmentationEngine } from '../src/evaluation/LLMAugmentationEngine.js';
import { EvaluationEngine } from '../src/evaluation/EvaluationEngine.js';

/* Deterministic ids/timestamps so assertions on reports are stable. */
let seq = 0;
const fixedIds = () => () => `fb-fixed-${++seq}`;
const fixedNow = () => '2026-01-01T00:00:00.000Z';

const parkingLotProblem = () =>
  Problem.fromJSON({
    id: 'parking-lot',
    title: 'Parking Lot',
    difficulty: 'EASY',
    statement: 'Design a parking lot.',
    requirements: [
      { id: 'PL-1', text: 'Track occupancy of spots per type.', keywords: ['spot', 'free', 'occupancy'] },
      { id: 'PL-2', text: 'Support different vehicle types and spot compatibility.', keywords: ['vehicle', 'car', 'type'] },
      { id: 'PL-3', text: 'Entry issues a ticket; exit computes the fee.', keywords: ['entry', 'exit', 'ticket', 'fee'] },
    ],
    rubric: [
      { key: 'requirement-coverage', label: 'Coverage', weight: 30 },
      { key: 'class-design', label: 'Class design', weight: 25 },
      { key: 'relationships', label: 'Relationships', weight: 20 },
      { key: 'rationale-and-tradeoffs', label: 'Rationale', weight: 15 },
      { key: 'extensibility', label: 'Extensibility', weight: 10 },
    ],
  });

function makeAttempt(submissionPayload) {
  const attempt = Attempt.start({ id: 'att-1', problemId: 'parking-lot', learnerId: 'learner-1' });
  attempt.saveDraft(Submission.fromJSON(submissionPayload));
  attempt.submit();
  return attempt;
}

const strongSubmission = {
  classes: [
    { name: 'ParkingLot', responsibilities: ['finds a free spot for a vehicle', 'issues ticket at entry gate', 'collects fee at exit gate'], collaborators: ['Floor', 'ParkingSpot', 'Vehicle', 'Ticket', 'FeeStrategy'] },
    { name: 'Floor', responsibilities: ['owns spots and tracks occupancy per spot type'], collaborators: ['ParkingSpot'] },
    { name: 'ParkingSpot', responsibilities: ['knows its size and whether it is free'], collaborators: [] },
    { name: 'Vehicle', responsibilities: ['carries type and spot-size compatibility'], collaborators: [] },
    { name: 'Ticket', responsibilities: ['records entry time for fee calculation'], collaborators: [] },
    { name: 'FeeStrategy', responsibilities: ['computes the fee from duration and vehicle type'], collaborators: [] },
  ],
  relationships: [
    { from: 'ParkingLot', to: 'Floor', type: 'composition', description: 'lot owns floors' },
    { from: 'Floor', to: 'ParkingSpot', type: 'composition', description: 'floor owns spots' },
    { from: 'ParkingLot', to: 'FeeStrategy', type: 'interface-implementation', description: 'pluggable pricing policy' },
  ],
  rationale:
    'Fee calculation sits behind an interface so a promotional pricing strategy can replace it without touching the exit gate; this keeps coupling low. ' +
    'I rejected pricing on Ticket because the ticket is a data record — that would hurt cohesion. Spot search is a single responsibility because both entry and exit need availability; ' +
    'the trade-off favours extensibility when pricing rules change. Polymorphism over the vehicle hierarchy handles new vehicle types.',
};

const weakSubmission = {
  classes: [
    {
      name: 'System',
      responsibilities: ['does everything the machine needs', 'handles all the money', 'keeps internal state', 'prints stuff', 'talks to hardware', 'validates things', 'manages the flow', 'survives audits'],
      collaborators: ['Mystery'],
    },
  ],
  relationships: [
    { from: 'System', to: 'Ghost', type: ' association ', description: 'unknown' },
  ],
  rationale: 'I made one class because it is simpler to write and I did not think about alternatives at all, honestly. It works fine for me so far and I plan to keep it this way for now.',
};

describe('RubricEvaluationEngine (deterministic baseline)', () => {
  test('is an EvaluationEngine (strategy seam respected)', () => {
    const engine = new RubricEvaluationEngine();
    assert.ok(engine instanceof EvaluationEngine);
  });

  test('strong submission: high score, full coverage, evidence attached', async () => {
    const engine = new RubricEvaluationEngine({ idGenerator: fixedIds(), now: fixedNow });
    const report = await engine.evaluate(makeAttempt(strongSubmission), parkingLotProblem());

    assert.equal(report.engine, 'deterministic');
    assert.equal(report.attemptId, 'att-1');
    assert.ok(report.overallScore >= 80, `expected >= 80, got ${report.overallScore}`);
    assert.equal(report.dimensions.length, 5);
    assert.equal(report.generatedAt, fixedNow());

    const coverage = new Map(report.coverage.map((c) => [c.requirementId, c.level]));
    assert.equal(coverage.get('PL-1'), 'full');
    assert.equal(coverage.get('PL-2'), 'full');
    assert.equal(coverage.get('PL-3'), 'full');

    const covered = report.coverage.find((c) => c.requirementId === 'PL-3');
    assert.ok(covered.evidence.length > 10, 'coverage evidence quotes the submission');
    assert.ok(report.strengths.length >= 1);
  });

  test('weak submission: god class, dangling refs and thin rationale are all flagged', async () => {
    const engine = new RubricEvaluationEngine({ idGenerator: fixedIds(), now: fixedNow });
    const report = await engine.evaluate(makeAttempt(weakSubmission), parkingLotProblem());

    assert.ok(report.overallScore < 50, `expected < 50, got ${report.overallScore}`);
    const messages = report.dimensions.flatMap((d) => d.findings.map((f) => f.message)).join(' ');
    assert.match(messages, /god class/i);
    assert.match(messages, /not declared/i); // Ghost + Mystery are dangling refs
    assert.match(messages, /trade-off/i);
    assert.match(messages, /rationale is short/i);
    assert.ok(report.improvements.length > 0, 'improvements surfaced for the UI');
  });

  test('evaluation is reproducible: same input -> identical report', async () => {
    const engine = () => new RubricEvaluationEngine({ idGenerator: () => 'fb-same', now: fixedNow });
    const r1 = await engine().evaluate(makeAttempt(strongSubmission), parkingLotProblem());
    const r2 = await engine().evaluate(makeAttempt(strongSubmission), parkingLotProblem());
    assert.deepEqual(JSON.parse(JSON.stringify(r1)), JSON.parse(JSON.stringify(r2)));
  });

  test('evidence quotes come from the learner submission, not the problem', async () => {
    const engine = new RubricEvaluationEngine({ idGenerator: fixedIds(), now: fixedNow });
    const report = await engine.evaluate(makeAttempt(strongSubmission), parkingLotProblem());
    const withEvidence = report.coverage.filter((c) => c.evidence);
    assert.ok(withEvidence.length > 0);
    for (const c of withEvidence) {
      assert.ok(
        strongSubmission.rationale.includes(c.evidence.slice(0, 40)) ||
        JSON.stringify(strongSubmission).toLowerCase().includes(c.evidence.split(' ')[0].toLowerCase()),
        `evidence "${c.evidence}" should trace back to the submission`
      );
    }
  });

  test('evaluating an attempt without a submission fails loudly', async () => {
    const engine = new RubricEvaluationEngine({ idGenerator: fixedIds(), now: fixedNow });
    const attempt = Attempt.start({ id: 'att-empty', problemId: 'parking-lot', learnerId: 'l' });
    await assert.rejects(() => engine.evaluate(attempt, parkingLotProblem()), /no submission/i);
  });
});

/* ------------------------------------------------------------------ */
/* LLM augmentation: graceful degradation in all failure modes         */
/* ------------------------------------------------------------------ */

class FakeLLMClient {
  constructor({ behavior = 'ok', model = 'fake-model' } = {}) {
    this.behavior = behavior;
    this.model = model;
    this.calls = 0;
  }
  get configured() { return true; }
  async completeJSON(system, user) {
    this.calls++;
    this.lastPrompt = { system, user };
    if (this.behavior === 'ok') {
      return {
        summary: 'Solid decomposition overall.',
        strengths: ['Fee strategy isolated behind an interface.'],
        improvements: ['Consider who owns the ticket lifecycle.'],
        dimensionNotes: { 'class-design': 'Responsibilities are crisp.' },
      };
    }
    if (this.behavior === 'garbage') return { unrelated: 'shape' };
    if (this.behavior === 'throw') throw new Error('network down');
    if (this.behavior === 'null') return null;
    return null;
  }
}

class UnconfiguredClient {
  get configured() { return false; }
  async completeJSON() { throw new Error('should never be called'); }
}

describe('LLMAugmentationEngine (decorator over deterministic engine)', () => {
  const inner = () => new RubricEvaluationEngine({ idGenerator: fixedIds(), now: fixedNow });

  test('unconfigured client: deterministic report ships untouched', async () => {
    const engine = new LLMAugmentationEngine({ inner: inner(), client: new UnconfiguredClient() });
    const report = await engine.evaluate(makeAttempt(strongSubmission), parkingLotProblem());
    assert.equal(report.engine, 'deterministic');
    assert.equal(report.llm.used, false);
    assert.equal(report.llm.reason, 'not-configured');
  });

  test('successful LLM response: merged as advisory, engine label updated, scores unchanged', async () => {
    const client = new FakeLLMClient({ behavior: 'ok' });
    const baseline = await inner().evaluate(makeAttempt(strongSubmission), parkingLotProblem());
    const engine = new LLMAugmentationEngine({ inner: inner(), client });
    const report = await engine.evaluate(makeAttempt(strongSubmission), parkingLotProblem());

    assert.equal(report.engine, 'deterministic+llm-augmented');
    assert.equal(report.llm.used, true);
    assert.equal(report.llm.model, 'fake-model');
    assert.equal(report.overallScore, baseline.overallScore, 'LLM cannot change deterministic scores');
    assert.deepEqual(
      report.dimensions.map((d) => d.score),
      baseline.dimensions.map((d) => d.score)
    );
    assert.ok(client.calls === 1);
    assert.match(report.llm.summary, /Solid decomposition/);
  });

  test('invalid LLM JSON shape: rejected, deterministic report survives', async () => {
    const client = new FakeLLMClient({ behavior: 'garbage' });
    const engine = new LLMAugmentationEngine({ inner: inner(), client });
    const report = await engine.evaluate(makeAttempt(strongSubmission), parkingLotProblem());
    assert.equal(report.llm.used, false);
    assert.equal(report.llm.reason, 'invalid-response');
    assert.equal(report.overallScore >= 0, true);
  });

  test('throwing LLM client: fallback with error captured, report still returned', async () => {
    const client = new FakeLLMClient({ behavior: 'throw' });
    const engine = new LLMAugmentationEngine({ inner: inner(), client });
    const report = await engine.evaluate(makeAttempt(strongSubmission), parkingLotProblem());
    assert.equal(report.llm.used, false);
    assert.equal(report.llm.reason, 'error');
    assert.match(report.llm.error, /network down/);
    assert.equal(report.engine, 'deterministic');
  });

  test('LLM prompt contains the learner submission and the problem requirements', async () => {
    const client = new FakeLLMClient({ behavior: 'ok' });
    const engine = new LLMAugmentationEngine({ inner: inner(), client });
    await engine.evaluate(makeAttempt(strongSubmission), parkingLotProblem());
    const promptBody = JSON.parse(client.lastPrompt.user);
    assert.equal(promptBody.problem.title, 'Parking Lot');
    assert.ok(promptBody.learnerSubmission.classes.length >= 4);
    assert.ok(Array.isArray(promptBody.deterministicFindings.coverage));
  });

  test('missing inner engine is a wiring error, not a runtime surprise', () => {
    assert.throws(() => new LLMAugmentationEngine({ client: new FakeLLMClient() }), /inner/);
  });
});
