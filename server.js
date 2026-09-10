/**
 * server.js — composition root + entry point.
 *
 * This is the ONLY file that knows how the pieces are wired together:
 *
 *   RubricEvaluationEngine (deterministic)
 *        └─ wrapped by LLMAugmentationEngine (optional, degrades gracefully)
 *               └─ driven by EvaluationService (async, retry, watchdog)
 *                      └─ exposed by createApp (HTTP + static frontend)
 *
 * Swapping the engine, adding a real DB, or changing the port should only
 * require touching this file (or its injected dependencies in tests).
 */
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from './src/http/app.js';
import { ProblemRepository } from './src/repositories/ProblemRepository.js';
import { AttemptRepository, FeedbackRepository } from './src/repositories/AttemptRepository.js';
import { RubricEvaluationEngine } from './src/evaluation/RubricEvaluationEngine.js';
import { LLMAugmentationEngine } from './src/evaluation/LLMAugmentationEngine.js';
import { LLMClient } from './src/evaluation/LLMClient.js';
import { EvaluationService } from './src/evaluation/EvaluationService.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Boot the whole application.
 *
 * @param {object} [options]
 * @param {number} [options.port=PORT env or 3000]
 * @param {string} [options.dataDir]   - defaults to <project>/data
 * @param {string} [options.staticDir] - defaults to <project>/public
 * @param {object} [options.llmClient] - override the LLM adapter (tests)
 * @param {object} [options.serviceOptions] - override EvaluationService tuning (tests)
 * @returns {Promise<{server: import('node:http').Server, deps: object, port: number}>}
 */
export async function start(options = {}) {
  const dataDir = options.dataDir ?? join(here, 'data');
  const staticDir = options.staticDir ?? join(here, 'public');
  const port = options.port ?? Number(process.env.PORT ?? 3000);

  const problemRepository = new ProblemRepository(join(dataDir, 'problems'));
  const loaded = await problemRepository.loadSeeds();

  const attemptRepository = new AttemptRepository(join(dataDir, 'store', 'attempts.json'));
  const feedbackRepository = new FeedbackRepository(join(dataDir, 'store', 'feedback.json'));

  const llmClient = options.llmClient ?? new LLMClient(); // reads LLM_* env vars
  const engine = new LLMAugmentationEngine({
    inner: new RubricEvaluationEngine(),
    client: llmClient,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 25000),
  });

  const evaluationService = new EvaluationService(
    { engine, attemptRepository, feedbackRepository, problemRepository },
    {
      retries: Number(process.env.EVALUATION_RETRIES ?? 1),
      timeoutMs: Number(process.env.EVALUATION_TIMEOUT_MS ?? 30000),
      ...options.serviceOptions,
    }
  );

  const handle = createApp({
    problemRepository,
    attemptRepository,
    feedbackRepository,
    evaluationService,
    llmClient,
    staticDir,
  });

  const server = createServer(handle);
  await new Promise((resolvePromise) => server.listen(port, resolvePromise));

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  console.log(`[lld-practice] ${loaded} problems loaded`);
  console.log(`[lld-practice] LLM augmentation: ${llmClient.configured ? `enabled (${llmClient.model})` : 'disabled (set LLM_API_KEY to enable)'}`);
  console.log(`[lld-practice] listening on http://localhost:${actualPort}`);

  return {
    server,
    port: actualPort,
    deps: { problemRepository, attemptRepository, feedbackRepository, evaluationService, llmClient },
    async stop() {
      await evaluationService.waitForIdle();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

/* Run when executed directly (`node server.js`), not when imported by tests. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start().catch((error) => {
    console.error('[lld-practice] failed to start:', error);
    process.exit(1);
  });
}
