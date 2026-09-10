import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Router } from './Router.js';
import { Submission } from '../domain/Submission.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';

/**
 * createApp — the HTTP boundary of the monolith.
 *
 * Responsibilities (and nothing more):
 *   - translate HTTP into domain calls (controllers are plain functions)
 *   - map domain errors to status codes in ONE place
 *   - serve the static frontend from public/
 *
 * Everything interesting lives behind injected dependencies, which is what
 * makes the API layer testable without a database or a real LLM.
 *
 * Learner identity: MVP is single-learner-by-default ('demo-learner'), but
 * every attempt is already tagged with a learnerId read from the
 * `x-learner-id` header, so multi-user is a session layer away — not a
 * schema migration.
 */

const BODY_LIMIT_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_LEARNER_ID = 'demo-learner';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * @param {object} deps
 * @param {import('../repositories/ProblemRepository.js').ProblemRepository} deps.problemRepository
 * @param {import('../repositories/AttemptRepository.js').AttemptRepository} deps.attemptRepository
 * @param {import('../repositories/AttemptRepository.js').FeedbackRepository} deps.feedbackRepository
 * @param {import('../evaluation/EvaluationService.js').EvaluationService} deps.evaluationService
 * @param {import('../evaluation/LLMClient.js').LLMClient} deps.llmClient
 * @param {string} deps.staticDir - absolute path to public/
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApp(deps) {
  const { problemRepository, attemptRepository, feedbackRepository, evaluationService, llmClient, staticDir } = deps;
  const staticRoot = resolve(staticDir);
  const router = buildRouter(deps);

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;

      if (pathname.startsWith('/api/')) {
        const matched = router.match(req.method, pathname);
        if (!matched) {
          return sendJSON(res, 404, { error: `No route for ${req.method} ${pathname}` });
        }
        const ctx = {
          req,
          res,
          params: matched.params,
          query: url.searchParams,
          learnerId: learnerIdFrom(req) ?? DEFAULT_LEARNER_ID,
          body: await readJSONBody(req),
        };
        const result = await matched.handler(ctx);
        if (result && !res.writableEnded) sendJSON(res, result.status ?? 200, result.body);
        return;
      }

      return serveStatic(res, staticRoot, pathname);
    } catch (error) {
      return sendError(res, error);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Route table — the whole API in one readable block                    */
/* ------------------------------------------------------------------ */

function buildRouter(deps) {
  const { problemRepository, attemptRepository, feedbackRepository, evaluationService, llmClient } = deps;
  const router = new Router();

  router.get('/api/health', () => ({
    status: 200,
    body: { ok: true, problems: problemRepository.count, llmConfigured: llmClient?.configured ?? false },
  }));

  router.get('/api/config', () => ({
    status: 200,
    body: {
      llmConfigured: llmClient?.configured ?? false,
      llmModel: llmClient?.configured ? llmClient.model : null,
      defaultLearnerId: DEFAULT_LEARNER_ID,
    },
  }));

  router.get('/api/problems', () => ({
    status: 200,
    body: {
      problems: problemRepository.list().map(problemSummary),
    },
  }));

  router.get('/api/problems/:id', ({ params }) => {
    const problem = problemRepository.get(params.id);
    if (!problem) throw new NotFoundError('Problem', params.id);
    return { status: 200, body: { problem: problem.toJSON() } };
  });

  router.post('/api/attempts', async ({ body, learnerId }) => {
    assertBodyObject(body);
    const problemId = body.problemId;
    if (typeof problemId !== 'string' || !problemId) {
      throw new ValidationError("Field 'problemId' is required to start an attempt.");
    }
    const problem = problemRepository.get(problemId);
    if (!problem) throw new NotFoundError('Problem', problemId);
    const attempt = await attemptRepository.create({ problemId, learnerId });
    return { status: 201, body: { attempt: attempt.toJSON(), problem: problemSummary(problem) } };
  });

  router.get('/api/attempts/:id', async ({ params }) => {
    const attempt = await attemptRepository.getOrThrow(params.id);
    const problem = problemRepository.get(attempt.problemId);
    return {
      status: 200,
      body: {
        attempt: attempt.toJSON(),
        problem: problem ? problemSummary(problem) : null,
      },
    };
  });

  router.put('/api/attempts/:id', async ({ params, body }) => {
    assertBodyObject(body);
    const attempt = await attemptRepository.getOrThrow(params.id);
    const submission = Submission.fromJSON(body.submission ?? body); // accept either shape
    attempt.saveDraft(submission);
    await attemptRepository.save(attempt);
    return { status: 200, body: { attempt: attempt.toJSON() } };
  });

  router.post('/api/attempts/:id/submit', async ({ params }) => {
    const attempt = await attemptRepository.getOrThrow(params.id);
    try {
      attempt.submit();
    } catch (error) {
      // A DRAFT attempt with no submission yet is a client problem, not a conflict.
      if (error.message.includes('with no submission')) throw new ValidationError(error.message);
      throw error;
    }
    await evaluationService.submitForEvaluation(attempt);
    return { status: 202, body: { attempt: attempt.toJSON(), message: 'Evaluation scheduled. Poll this attempt to see feedback.' } };
  });

  router.post('/api/attempts/:id/reevaluate', async ({ params }) => {
    const attempt = await attemptRepository.getOrThrow(params.id);
    if (!attempt.canRetryEvaluation) {
      return {
        status: 409,
        body: { error: `Attempt is ${attempt.status}; only FAILED attempts can be re-evaluated.` },
      };
    }
    await evaluationService.retryEvaluation(attempt); // owns FAILED -> EVALUATING
    return { status: 202, body: { attempt: attempt.toJSON(), message: 'Re-evaluation scheduled.' } };
  });

  router.get('/api/attempts/:id/feedback', async ({ params }) => {
    const attempt = await attemptRepository.getOrThrow(params.id);
    const report = await feedbackRepository.getByAttemptId(attempt.id);
    if (!report) {
      return {
        status: 404,
        body: {
          error:
            attempt.status === 'EVALUATED'
              ? 'Feedback report is missing for an evaluated attempt.'
              : 'Feedback is not ready yet. Keep polling the attempt until its status is EVALUATED.',
          attemptStatus: attempt.status,
        },
      };
    }
    return { status: 200, body: { feedback: report, attempt: attempt.toJSON() } };
  });

  router.get('/api/learners/me/attempts', async ({ learnerId, query }) => {
    const attempts = await attemptRepository.listByLearner(learnerId, {
      problemId: query.get('problemId') ?? undefined,
    });
    const history = await Promise.all(
      attempts.map(async (attempt) => ({
        id: attempt.id,
        problemId: attempt.problemId,
        problemTitle: problemRepository.get(attempt.problemId)?.title ?? '(unknown problem)',
        status: attempt.status,
        createdAt: attempt.createdAt,
        submittedAt: attempt.submittedAt,
        evaluatedAt: attempt.evaluatedAt,
        overallScore: attempt.status === 'EVALUATED'
          ? (await feedbackRepository.get(attempt.feedbackId))?.overallScore ?? null
          : null,
      }))
    );
    return { status: 200, body: { learnerId, attempts: history } };
  });

  return router;
}

/* ------------------------------------------------------------------ */
/* Request/response helpers                                             */
/* ------------------------------------------------------------------ */

function problemSummary(problem) {
  return {
    id: problem.id,
    title: problem.title,
    difficulty: problem.difficulty,
    timeboxMinutes: problem.timeboxMinutes,
    requirementCount: problem.requirements.length,
    context: problem.context,
  };
}

function learnerIdFrom(req) {
  const header = req.headers['x-learner-id'];
  if (typeof header === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(header)) return header;
  return null;
}

async function readJSONBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      throw new ValidationError('Request body exceeds the 1 MiB limit.');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Request body is not valid JSON.');
  }
}

function assertBodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('A JSON request body is required.');
  }
}

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, error) {
  const status = error.status ?? 500;
  if (status >= 500) {
    console.error('[http] unhandled error:', error);
  }
  sendJSON(res, status, { error: error.message ?? 'Unexpected server error.' });
}

/* ------------------------------------------------------------------ */
/* Static file serving (frontend)                                       */
/* ------------------------------------------------------------------ */

async function serveStatic(res, staticRoot, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = resolve(join(normalize(staticRoot), normalize(requested)));
  if (!target.startsWith(staticRoot)) {
    return sendJSON(res, 403, { error: 'Forbidden.' }); // path traversal guard
  }
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return sendJSON(res, 404, { error: 'Not found.' });
  }
  if (!stat.isFile()) return sendJSON(res, 404, { error: 'Not found.' });

  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  createReadStream(target).pipe(res);
}
