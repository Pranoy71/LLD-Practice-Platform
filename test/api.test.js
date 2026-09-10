import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../server.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * End-to-end API tests: a real HTTP server on an ephemeral port, real JSON
 * over the wire, real file persistence in a temp dir — the learner journey
 * the assignment asks to be demonstrable:
 *
 *   choose problem -> draft -> submit -> poll -> feedback -> history
 */

const BASE = 'http://127.0.0.1';
let app;
let baseUrl;
let dataDir;

const goodParkingLotSubmission = {
  classes: [
    { name: 'ParkingLot', responsibilities: ['finds a free spot for arriving vehicles', 'issues ticket at entry gate', 'collects fee at exit gate'], collaborators: ['Floor', 'Ticket', 'Vehicle', 'FeeStrategy'] },
    { name: 'Floor', responsibilities: ['tracks spot occupancy per spot type'], collaborators: ['ParkingSpot'] },
    { name: 'ParkingSpot', responsibilities: ['knows size and free/taken status'], collaborators: [] },
    { name: 'Vehicle', responsibilities: ['carries vehicle type for fee and size compatibility'], collaborators: [] },
    { name: 'Ticket', responsibilities: ['records entry time for duration-based fee'], collaborators: [] },
    { name: 'FeeStrategy', responsibilities: ['computes fee from duration and vehicle type'], collaborators: [] },
  ],
  relationships: [
    { from: 'ParkingLot', to: 'Floor', type: 'composition', description: 'lot owns floors' },
    { from: 'Floor', to: 'ParkingSpot', type: 'composition', description: 'floor owns spots' },
    { from: 'ParkingLot', to: 'FeeStrategy', type: 'interface-implementation', description: 'pricing policy pluggable via interface' },
  ],
  rationale:
    'Fee calculation sits behind an interface so a promotional pricing strategy can replace it without touching the exit gate; this keeps coupling low. ' +
    'I rejected pricing on the Ticket because the ticket is a data record and that would hurt cohesion. Spot search is a single responsibility shared by entry and exit flows to avoid duplication. ' +
    'The vehicle hierarchy uses polymorphism so new vehicle types extend the design instead of editing it (open-closed).',
};

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-learner-id': 'itest-learner', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

before(async () => {
  // problems are curriculum: copy the repo's seeds into a scratch data dir
  // (store files land there too, so tests never touch the repo's data/store)
  dataDir = await fs.mkdtemp(join(tmpdir(), 'lld-api-'));
  const seedTarget = join(dataDir, 'problems');
  await fs.mkdir(seedTarget, { recursive: true });
  const seedSource = join(PROJECT_ROOT, 'data', 'problems');
  for (const file of await fs.readdir(seedSource)) {
    if (file.endsWith('.json')) await fs.copyFile(join(seedSource, file), join(seedTarget, file));
  }
  app = await start({
    port: 0,
    dataDir,
    serviceOptions: { retries: 0, retryDelayMs: 5 },
  });
  baseUrl = `${BASE}:${app.port}`;
});

after(async () => {
  if (app?.stop) await app.stop();
});

describe('learner journey over HTTP', () => {
  test('health + config: server boots with seeds and reports LLM status', async () => {
    const health = await api('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.problems, 3);
    assert.equal(health.body.llmConfigured, false); // no key in the test environment
  });

  test('problem catalogue: list and detail, 404 for unknown problem', async () => {
    const list = await api('/api/problems');
    assert.equal(list.status, 200);
    assert.equal(list.body.problems.length, 3);
    assert.ok(list.body.problems.every((p) => p.requirementCount >= 5));

    const detail = await api('/api/problems/parking-lot');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.problem.title, 'Parking Lot');
    assert.ok(detail.body.problem.rubric.length >= 5);

    const missing = await api('/api/problems/does-not-exist');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /not found/i);
  });

  test('full loop: create attempt -> save draft -> submit -> feedback -> history', async () => {
    // 1. start an attempt
    const created = await api('/api/attempts', { method: 'POST', body: JSON.stringify({ problemId: 'parking-lot' }) });
    assert.equal(created.status, 201);
    const attemptId = created.body.attempt.id;
    assert.equal(created.body.attempt.status, 'DRAFT');

    // 2. save an invalid draft -> 400 with a friendly message, nothing saved
    const badDraft = await api(`/api/attempts/${attemptId}`, {
      method: 'PUT',
      body: JSON.stringify({ submission: { classes: [], relationships: [], rationale: 'too short' } }),
    });
    assert.equal(badDraft.status, 400);
    assert.ok(badDraft.body.error.length > 10);

    // 3. save a valid draft
    const draft = await api(`/api/attempts/${attemptId}`, {
      method: 'PUT',
      body: JSON.stringify({ submission: goodParkingLotSubmission }),
    });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.attempt.submission.classes.length, 6);

    // 4. submit -> 202, evaluation scheduled (asynchronously)
    const submitted = await api(`/api/attempts/${attemptId}/submit`, { method: 'POST' });
    assert.equal(submitted.status, 202);

    // 5. poll until evaluated (deterministic engine: near-instant)
    let final = null;
    for (let i = 0; i < 40; i++) {
      const current = await api(`/api/attempts/${attemptId}`);
      if (current.body.attempt.status === 'EVALUATED' || current.body.attempt.status === 'FAILED') {
        final = current.body.attempt;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(final, 'attempt reached a terminal state');
    assert.equal(final.status, 'EVALUATED');

    // 6. feedback is explainable: dimensions, coverage with evidence
    const feedback = await api(`/api/attempts/${attemptId}/feedback`);
    assert.equal(feedback.status, 200);
    const report = feedback.body.feedback;
    assert.ok(report.overallScore >= 60, `strong submission should score well (got ${report.overallScore})`);
    assert.ok(report.dimensions.length >= 5);
    assert.ok(report.coverage.length === 6);
    assert.ok(report.coverage.some((c) => c.evidence), 'coverage carries evidence quotes');
    assert.equal(report.engine, 'deterministic');
    assert.equal(report.llm.used, false);
    assert.equal(report.llm.reason, 'not-configured');

    // 7. history shows the attempt with its score, newest first
    const history = await api('/api/learners/me/attempts');
    assert.equal(history.status, 200);
    const mine = history.body.attempts.filter((a) => a.id === attemptId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, 'EVALUATED');
    assert.equal(mine[0].overallScore, report.overallScore);
    assert.equal(mine[0].problemTitle, 'Parking Lot');
  });

  test('attempt immutability: double submit -> 409, edit after submit -> 409', async () => {
    const created = await api('/api/attempts', { method: 'POST', body: JSON.stringify({ problemId: 'vending-machine' }) });
    const attemptId = created.body.attempt.id;
    await api(`/api/attempts/${attemptId}`, { method: 'PUT', body: JSON.stringify({ submission: goodParkingLotSubmission }) });
    const first = await api(`/api/attempts/${attemptId}/submit`, { method: 'POST' });
    assert.equal(first.status, 202);
    const second = await api(`/api/attempts/${attemptId}/submit`, { method: 'POST' });
    assert.equal(second.status, 409);

    const edit = await api(`/api/attempts/${attemptId}`, { method: 'PUT', body: JSON.stringify({ submission: goodParkingLotSubmission }) });
    assert.equal(edit.status, 409);
  });

  test('404s: unknown attempt, feedback for unknown attempt', async () => {
    assert.equal((await api('/api/attempts/nope')).status, 404);
    assert.equal((await api('/api/attempts/nope/feedback')).status, 404);
  });

  test('submitting an empty draft -> 400 with guidance', async () => {
    const created = await api('/api/attempts', { method: 'POST', body: JSON.stringify({ problemId: 'elevator-system' }) });
    const submitted = await api(`/api/attempts/${created.body.attempt.id}/submit`, { method: 'POST' });
    assert.equal(submitted.status, 400);
    assert.match(submitted.body.error, /submission/i);
  });

  test('creating an attempt for an unknown problem -> 404', async () => {
    const created = await api('/api/attempts', { method: 'POST', body: JSON.stringify({ problemId: 'ghost-problem' }) });
    assert.equal(created.status, 404);
  });

  test('bad JSON body -> 400 (not a 500)', async () => {
    const response = await fetch(`${baseUrl}/api/attempts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-learner-id': 'itest-learner' },
      body: '{"problemId": broken json',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /valid JSON/i);
  });

  test('missing route under /api -> 404 JSON, unknown pages -> 404', async () => {
    const missing = await api('/api/no-such-route');
    assert.equal(missing.status, 404);

    const page = await fetch(`${baseUrl}/no-such-page`);
    assert.equal(page.status, 404);
  });

  test('learner id is honoured: attempts are scoped per learner', async () => {
    await api('/api/attempts', { method: 'POST', body: JSON.stringify({ problemId: 'parking-lot' }) });
    const other = await fetch(`${baseUrl}/api/learners/me/attempts`, {
      headers: { 'x-learner-id': 'someone-else' },
    });
    const body = await other.json();
    assert.equal(other.status, 200);
    assert.equal(body.attempts.length, 0);
  });

  test('static frontend is served (the demo is a browser experience)', async () => {
    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    const html = await index.text();
    assert.match(html, /LLD\s*Practice/);

    const css = await fetch(`${baseUrl}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
  });

  test('path traversal is blocked', async () => {
    const response = await fetch(`${baseUrl}/../server.js`);
    assert.ok([403, 404].includes(response.status), `expected 403/404, got ${response.status}`);
  });
});
