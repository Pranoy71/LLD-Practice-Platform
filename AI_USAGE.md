# AI Usage Report

**Candidate:** Bishal Chandra Debnath · CipherSchools Hiring Assignment · Sep 2026

This assignment was built with AI assistance (Claude/ChatGPT-class tools plus code
completion), and this document records the **five most meaningful AI-assisted
decisions** — what the AI suggested, what I accepted, what I rejected, and why.
The intent is to show judgement, not delegation: every accepted suggestion was
tested (53 automated tests), and the two rejections below are where I think the
product is better *because* the AI was overruled.

---

## Decision 1 — Deterministic-first evaluation, LLM as advisory only

**Context:** The assignment asks "which parts of evaluation should be deterministic,
and which parts benefit from an LLM?" — the core design question of the product.

**What AI suggested (first draft):** send the whole submission to an LLM, ask for a
score 0–100 with strengths and improvements, and render that as the feedback.
Simple, flexible, one prompt.

**What I did:** rejected the LLM-as-oracle approach and built the
`RubricEvaluationEngine` (deterministic: requirement coverage with evidence quotes,
god-class detection, dangling relationship references, trade-off vocabulary) with the
`LLMAugmentationEngine` as a **decorator that can only add commentary, never change
scores** (`LLMAugmentationEngine.js` enforces this by merging only the `llm` block).

**Why:** three reasons. Reproducibility — the same submission must produce the same
score, or learners can't trust progress comparisons. Explainability — every
deterministic finding quotes evidence from the learner's own submission; LLM
explanations are plausible-sounding but unauditable. Availability — the demo must
work with no API key, and evaluation must not silently change quality when a
provider is down. The LLM is genuinely better at the *reasoning* layer (judging
design intent, coaching), so it got exactly that job.

## Decision 2 — Structured-text submission format instead of free text or code

**Context:** The assignment lets the candidate choose the submission form
(text, code, diagram, or combination).

**What AI suggested:** a single free-form textarea ("maximally flexible, and the
LLM can parse anything"), and in another round: parse learner-submitted Java/Python
code into an AST and evaluate that.

**What I accepted:** the structured-text middle ground — a guided editor with
**classes (name / responsibilities / collaborators), relationships
(from / to / type / why), and a rationale** — validated by `Submission.fromJSON()`.

**Why:** free text makes deterministic checks weak (everything depends on the
LLM's mood) and code-first evaluates syntax, not design thinking — learners stop
explaining *why*. The structured form keeps every field human-written while staying
parse-friendly: coverage checks, god-class detection and dangling-reference checks
all run on this structure deterministically. The format is a value object with its
own validation seam, so a diagram- or code-first format can be added later without
touching the evaluators.

## Decision 3 — EvaluationService failure handling (timeout, retry, FAILED state)

**Context:** The assignment explicitly asks "what should happen if evaluation takes
time or fails? Keep this practical."

**What AI suggested:** a job table + background worker + exponential backoff +
dead-letter queue — essentially a mini distributed-systems answer.

**What I did:** rejected the infrastructure. `EvaluationService` keeps everything
in-process: a bounded queue (max 2 concurrent), a **watchdog timeout** per run, one
retry, then a `FAILED` state that keeps the learner's answer intact and offers
**Retry evaluation**. The attempt state machine (`Attempt.js`) makes
`DRAFT → SUBMITTED → EVALUATING → EVALUATED | FAILED` explicit, with FAILED →
EVALUATING as the recovery path.

**Why:** the assignment warns against turning this into a distributed-systems
project. A monolith with an explicit failure state and a visible retry button
answers the actual user need (never lose the learner's work, never hang silently)
at demo scale. The `EvaluationService`/`EvaluationEngine` seam is where a real
queue would attach later — that's documented rather than built.

**Bonus:** AI-generated edge-case tests caught two real bugs here, both fixed:
uncleared watchdog timers kept the process alive (now cleared in `finally`), and
a transition-ownership bug where `retryEvaluation` and the controller both tried
to own `FAILED → EVALUATING` (the service now owns it exclusively).

## Decision 4 — Frontend: vanilla JS SPA instead of React/Next

**Context:** how to present the practice loop (problem list → editor → polling →
feedback → history).

**What AI suggested:** scaffold Next.js + React + a UI kit (the "standard" modern
stack), with polling via a state library.

**What I did:** vanilla JS with a hash router, ~600 lines total, served by the same
Node process. Polling is a plain `setTimeout` loop.

**Why:** the evaluation weights LLD/domain design at 25% and implementation at
10%; a frontend framework would spend the assignment's time budget on tooling and
add an install/build step between "clone" and "demo". Zero-dependency `node
server.js` is the strongest demo posture for a 2-day prototype. If this became a
real product with a team, the API is clean enough that a framework frontend could
replace `public/` without touching the backend.

## Decision 5 — Seed content: problems-as-data with rubric weights and keyword synonyms

**Context:** the three LLD problems (Parking Lot, Vending Machine, Elevator) and
their requirements.

**What AI suggested:** hardcode problems in JS classes; write requirements as
plain strings; match keywords with exact equality.

**What I did:** problems live in `data/problems/*.json` (loaded and validated at
boot), each requirement carries **keyword sets including synonyms** (e.g.
`["fee", "price", "pricing", "cost", "strategy", "duration"]`), and each problem
carries **rubric weights as data** summing to 100. Matching is lexical with
plural/singular tolerance (`sameWord()` in `RubricEvaluationEngine.js`).

**Why:** problems are curriculum, not code — a future problem shouldn't require an
engineer. Synonym sets accepted because exact-match coverage produces false
negatives ("pricing" vs "price") that would frustrate learners; plural tolerance
was the AI's concrete suggestion and survived testing. Rubric-as-data lets a
problem emphasise different dimensions without touching the engine — proven by a
unit test that swaps weights.

---

## Where AI was *not* used

- The final rubric scoring bands (verdict thresholds, penalty sizes) were tuned by
  running weak/strong/medium sample submissions and adjusting until the verdicts
  felt right — a judgement call about feedback quality, not a generation task.
- The attempt-immutability decision (submitted answers can't be edited; "try again"
  = new attempt) is a product-values call: history must stay trustworthy.
- All acceptance was by the test suite (`npm test`, 53 tests) and a manual
  end-to-end pass, not by trusting generated output.

## Tools

- Claude (GLM) for architecture discussion, code drafting, and test case generation.
- The AI Usage guidance in the assignment brief itself, for the structure of this
  document.
