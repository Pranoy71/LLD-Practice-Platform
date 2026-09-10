import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Attempt, AttemptStatus } from '../src/domain/Attempt.js';
import { Submission } from '../src/domain/Submission.js';
import { Problem } from '../src/domain/Problem.js';
import { ValidationError, InvalidTransitionError, NotFoundError } from '../src/domain/errors.js';

const validSubmission = () =>
  Submission.fromJSON({
    classes: [
      { name: 'ParkingLot', responsibilities: ['assigns spots'], collaborators: ['Vehicle'] },
    ],
    relationships: [
      { from: 'ParkingLot', to: 'Vehicle', type: 'association', description: 'tracks vehicles' },
    ],
    rationale: 'A'.repeat(120),
  });

const fakeProblem = () =>
  Problem.fromJSON({
    id: 'test-problem',
    title: 'Test Problem',
    difficulty: 'EASY',
    statement: 'Design something.',
    requirements: [{ id: 'R1', text: 'It must do something.', keywords: ['something'] }],
    rubric: [{ key: 'requirement-coverage', label: 'Coverage', weight: 100 }],
  });

describe('Attempt state machine', () => {
  test('fresh attempt starts in DRAFT and is editable', () => {
    const attempt = Attempt.start({ id: 'a1', problemId: 'p1', learnerId: 'l1' });
    assert.equal(attempt.status, AttemptStatus.DRAFT);
    assert.equal(attempt.isEditable, true);
    assert.equal(attempt.submission, null);
  });

  test('happy path: DRAFT -> SUBMITTED -> EVALUATING -> EVALUATED', () => {
    const attempt = Attempt.start({ id: 'a2', problemId: 'p1', learnerId: 'l1' });
    attempt.saveDraft(validSubmission());
    attempt.submit();
    attempt.markEvaluating();
    attempt.markEvaluated('fb-1');
    assert.equal(attempt.status, AttemptStatus.EVALUATED);
    assert.equal(attempt.feedbackId, 'fb-1');
    assert.ok(attempt.evaluatedAt);
    // EVALUATED is terminal: no further transitions allowed
    assert.throws(() => attempt.markEvaluating(), InvalidTransitionError);
    assert.throws(() => attempt.saveDraft(validSubmission()), InvalidTransitionError);
  });

  test('submitting without a submission is rejected', () => {
    const attempt = Attempt.start({ id: 'a3', problemId: 'p1', learnerId: 'l1' });
    assert.throws(() => attempt.submit(), InvalidTransitionError);
  });

  test('editing after submit is rejected (immutability for trustworthy history)', () => {
    const attempt = Attempt.start({ id: 'a4', problemId: 'p1', learnerId: 'l1' });
    attempt.saveDraft(validSubmission());
    attempt.submit();
    assert.throws(() => attempt.saveDraft(validSubmission()), InvalidTransitionError);
    assert.equal(attempt.isEditable, false);
  });

  test('FAILED is recoverable: markFailed -> re-evaluate path', () => {
    const attempt = Attempt.start({ id: 'a5', problemId: 'p1', learnerId: 'l1' });
    attempt.saveDraft(validSubmission());
    attempt.submit();
    attempt.markEvaluating();
    attempt.markFailed('LLM timed out');
    assert.equal(attempt.status, AttemptStatus.FAILED);
    assert.equal(attempt.canRetryEvaluation, true);
    assert.equal(attempt.evaluationError, 'LLM timed out');
    attempt.markEvaluating(); // FAILED -> EVALUATING allowed
    attempt.markEvaluated('fb-2');
    assert.equal(attempt.status, AttemptStatus.EVALUATED);
    assert.equal(attempt.evaluationError, null); // error cleared on success
  });

  test('invalid transitions throw with the from/to states in the message', () => {
    const attempt = Attempt.start({ id: 'a6', problemId: 'p1', learnerId: 'l1' });
    assert.throws(() => attempt.markEvaluated('fb'), (err) =>
      err instanceof InvalidTransitionError && err.message.includes('DRAFT'));
  });
});

describe('Submission validation (structured text format)', () => {
  test('accepts a well-formed submission and exposes helpers', () => {
    const submission = validSubmission();
    assert.equal(submission.format, 'structured-text');
    assert.ok(submission.declaredClassNames.has('parkinglot'));
    assert.ok(submission.text.includes('assigns spots'));
    assert.equal(submission.toJSON().classes.length, 1);
  });

  test('multiple responsibilities and collaborators are preserved (no silent truncation)', () => {
    const submission = Submission.fromJSON({
      classes: [
        {
          name: 'ParkingLot',
          responsibilities: ['finds a free spot', 'issues a ticket', 'collects the fee', 'delegates to floors'],
          collaborators: ['Floor', 'Vehicle', 'Ticket'],
        },
      ],
      relationships: [],
      rationale: 'r'.repeat(120),
    });
    assert.equal(submission.classes[0].responsibilities.length, 4);
    assert.equal(submission.classes[0].collaborators.length, 3);
  });

  test('rejects zero classes with a learner-friendly message', () => {
    assert.throws(
      () => Submission.fromJSON({ classes: [], relationships: [], rationale: 'x'.repeat(150) }),
      (err) => err instanceof ValidationError && err.status === 400 && /at least one class/i.test(err.message)
    );
  });

  test('rejects duplicate class names', () => {
    assert.throws(
      () =>
        Submission.fromJSON({
          classes: [
            { name: 'Gate', responsibilities: ['x'], collaborators: [] },
            { name: 'gate', responsibilities: ['y'], collaborators: [] },
          ],
          relationships: [],
          rationale: 'x'.repeat(150),
        }),
      /unique/i
    );
  });

  test('rejects a class without responsibilities', () => {
    assert.throws(
      () =>
        Submission.fromJSON({
          classes: [{ name: 'Ghost', responsibilities: [], collaborators: [] }],
          relationships: [],
          rationale: 'x'.repeat(150),
        }),
      /responsibilit/i
    );
  });

  test('rejects a too-short rationale (the "why" is part of the format)', () => {
    assert.throws(
      () => Submission.fromJSON({
        classes: [{ name: 'A', responsibilities: ['x'], collaborators: [] }],
        relationships: [],
        rationale: 'too short',
      }),
      /rationale/i
    );
  });

  test('null/undefined payloads and non-objects are rejected, not crashed on', () => {
    for (const bad of [null, undefined, 'text', 42, []]) {
      assert.throws(() => Submission.fromJSON(bad), ValidationError);
    }
  });
});

describe('Problem validation', () => {
  test('rubric weights must sum to 100 (seed-data guard)', () => {
    assert.throws(
      () => Problem.fromJSON({
        ...fakeProblem(),
        rubric: [{ key: 'requirement-coverage', label: 'Coverage', weight: 40 }],
      }),
      /sum to 100/
    );
  });

  test('requirements must each carry keywords for the coverage check', () => {
    assert.throws(
      () => Problem.fromJSON({
        ...fakeProblem(),
        requirements: [{ id: 'R1', text: 'must do something', keywords: [] }],
      }),
      /keyword/
    );
  });
});

describe('error hierarchy maps to HTTP-ish statuses', () => {
  test('each domain error carries a stable code and status', () => {
    assert.equal(new ValidationError('x').status, 400);
    assert.equal(new InvalidTransitionError('A', 'B').status, 409);
    assert.equal(new NotFoundError('Attempt', 'a9').status, 404);
  });
});
