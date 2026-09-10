/* LLD Practice — frontend.
 *
 * Vanilla JS, no build step, no dependencies. Hash-based routing:
 *   #/               problem list
 *   #/problems/:id   problem detail + start attempt
 *   #/attempts/:id   attempt editor → status → feedback
 *   #/history        attempt history
 */

/* ------------------------------------------------------------------ */
/* tiny utilities                                                      */
/* ------------------------------------------------------------------ */

const $view = document.getElementById('view');
const LEARNER_KEY = 'lld-learner-id';

function learnerId() {
  return localStorage.getItem(LEARNER_KEY) || 'demo-learner';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-learner-id': learnerId(),
      ...(options.headers ?? {}),
    },
  });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON (rare) */ }
  if (!response.ok) {
    const message = body?.error ?? `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

let toastTimer = null;
function toast(message, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

document.getElementById('learner-chip').textContent = learnerId();

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);

async function render() {
  const hash = location.hash || '#/';
  const [, route, id] = hash.split('/'); // '#', 'problems', 'parking-lot'
  setNav(hash);
  window.pollAbort = true; // stop any running poller from a previous view

  try {
    if (route === '' || route === undefined) return viewProblems();
    if (route === 'problems' && id) return viewProblem(id);
    if (route === 'attempts' && id) return viewAttempt(id);
    if (route === 'history') return viewHistory();
    location.hash = '#/';
  } catch (error) {
    $view.innerHTML = `
      <section class="panel">
        <h1 class="muted">Something went wrong</h1>
        <p class="muted">${esc(error.message)}</p>
        <div class="btn-row"><a class="btn" href="#/">Back to problems</a></div>
      </section>`;
  }
}

function setNav(hash) {
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === hash || (hash.startsWith('#/problems') && a.getAttribute('href') === '#/'));
  });
}

/* ------------------------------------------------------------------ */
/* view: problems                                                      */
/* ------------------------------------------------------------------ */

async function viewProblems() {
  const { problems } = await api('/api/problems');
  $view.innerHTML = `
    <div class="page-head">
      <h1>Practice Low-Level Design</h1>
      <p>Pick a problem, design it with classes and relationships, and get explainable feedback you can act on.</p>
    </div>
    <div class="problem-grid">
      ${problems.map(problemCard).join('')}
    </div>`;
}

function problemCard(p) {
  return `
    <article class="problem-card">
      <div class="title-row">
        <h3><a href="#/problems/${esc(p.id)}">${esc(p.title)}</a></h3>
        <span class="chip ${esc(p.difficulty.toLowerCase())}">${esc(p.difficulty)}</span>
      </div>
      <p>${esc(p.context)}</p>
      <div class="problem-meta">
        <span>${p.requirementCount} requirements</span>
        <span>~${p.timeboxMinutes} min timebox</span>
      </div>
    </article>`;
}

/* ------------------------------------------------------------------ */
/* view: problem detail                                                */
/* ------------------------------------------------------------------ */

async function viewProblem(id) {
  const { problem } = await api(`/api/problems/${encodeURIComponent(id)}`);
  const history = await api(`/api/learners/me/attempts?problemId=${encodeURIComponent(id)}`);

  $view.innerHTML = `
    <div class="page-head">
      <h1>${esc(problem.title)}</h1>
      <p>${esc(problem.context)}</p>
    </div>

    <section class="panel">
      <div class="head-row">
        <span class="chip ${esc(problem.difficulty.toLowerCase())}">${esc(problem.difficulty)}</span>
        <span class="muted small">timebox: ~${problem.timeboxMinutes} min</span>
      </div>
      <h2>Problem statement</h2>
      <div class="muted">${problem.statement.split('\n\n').map(para => `<p>${esc(para).replace(/\n/g, '<br/>')}</p>`).join('')}</div>

      <h2>Requirements your design should cover <span class="muted small">(${problem.requirements.length})</span></h2>
      <ul class="req-list">
        ${problem.requirements.map((r) => `
          <li><span class="req-id">${esc(r.id)}</span><span>${esc(r.text)}</span></li>`).join('')}
      </ul>

      <h2>How you'll be evaluated</h2>
      <ul class="tick-list good">
        ${problem.rubric.map((c) => `
          <li><span class="tick">▸</span><span><strong>${esc(c.label)}</strong> <span class="muted small">(${c.weight}%)</span> — ${esc(c.hint ?? '')}</span></li>`).join('')}
      </ul>

      ${problem.thinkingHints?.length ? `
      <h2>Thinking hints <span class="muted small">(visible before you start)</span></h2>
      <div class="hint-box">${problem.thinkingHints.map((h) => `<div>• ${esc(h)}</div>`).join('')}</div>` : ''}

      <div class="btn-row">
        <button class="btn primary" id="start-attempt">Start attempt</button>
        <span class="muted small">You can save drafts and submit when ready.</span>
      </div>
    </section>

    ${history.attempts.length ? `
    <section class="panel">
      <h2>Your attempts on this problem</h2>
      ${historyTable(history.attempts)}
    </section>` : ''}
  `;

  document.getElementById('start-attempt').addEventListener('click', async () => {
    try {
      const { attempt } = await api('/api/attempts', { method: 'POST', body: JSON.stringify({ problemId: problem.id }) });
      location.hash = `#/attempts/${attempt.id}`;
    } catch (error) {
      toast(error.message, true);
    }
  });
}

/* ------------------------------------------------------------------ */
/* view: attempt (editor → polling → feedback)                          */
/* ------------------------------------------------------------------ */

async function viewAttempt(id) {
  const { attempt, problem } = await api(`/api/attempts/${encodeURIComponent(id)}`);

  if (attempt.status === 'DRAFT') return renderEditor(attempt, problem);
  if (attempt.status === 'SUBMITTED' || attempt.status === 'EVALUATING') return renderPolling(attempt, problem);
  if (attempt.status === 'FAILED') return renderFailed(attempt, problem);
  return renderFeedbackStage(attempt, problem);
}

/* ---------- DRAFT: the guided editor ---------- */

function renderEditor(attempt, problem) {
  const submission = attempt.submission ?? { classes: [{ name: '', responsibilities: [''], collaborators: [] }], relationships: [], rationale: '' };

  $view.innerHTML = `
    <div class="page-head">
      <h1>${esc(problem?.title ?? attempt.problemId)} — your design</h1>
      <p>Describe your design as structured text: classes, relationships, and the reasoning behind them. Every field you write becomes evidence for the feedback.</p>
    </div>

    <div class="panel">
      <div class="editor-section">
        <div class="section-head">
          <h3>Classes</h3>
          <button class="btn subtle" id="add-class">+ Add class</button>
        </div>
        <p class="muted small">Name (PascalCase noun) · one responsibility per line · collaborators are class names it talks to.</p>
        <div id="classes">${submission.classes.map((c, i) => classBlock(c, i)).join('')}</div>
      </div>

      <div class="editor-section">
        <div class="section-head">
          <h3>Relationships</h3>
          <button class="btn subtle" id="add-rel">+ Add relationship</button>
        </div>
        <p class="muted small">from --type--> to, plus one line on why. Types: inheritance, composition, aggregation, association, dependency, interface-implementation.</p>
        <div id="rels">${submission.relationships.map((r, i) => relBlock(r, i)).join('') || '<p class="muted small" id="no-rels">No relationships yet.</p>'}</div>
      </div>

      <div class="editor-section">
        <div class="section-head"><h3>Design rationale</h3></div>
        <div class="field">
          <label for="rationale">Why this shape? What did you reject? (~100 chars minimum, but more is better)</label>
          <textarea id="rationale" rows="7" placeholder="e.g. I kept the fee calculation behind an interface so a promotional pricing policy can replace it without touching the exit gate. I rejected putting pricing on the Ticket because ...">${esc(submission.rationale)}</textarea>
        </div>
      </div>

      <div class="btn-row">
        <button class="btn" id="save-draft">Save draft</button>
        <button class="btn primary" id="submit-attempt">Submit for feedback</button>
        <span class="muted small" id="save-note"></span>
      </div>
    </div>
  `;

  const bind = (selector, event, handler, parent = document) => {
    parent.querySelectorAll(selector).forEach((el) => el.addEventListener(event, handler));
  };

  bind('.remove-class', 'click', (e) => { e.target.closest('.class-block')?.remove(); renumber(); });
  bind('.remove-rel', 'click', (e) => { e.target.closest('.rel-row')?.remove(); syncRelHint(); });

  document.getElementById('add-class').addEventListener('click', () => {
    document.getElementById('classes').insertAdjacentHTML('beforeend', classBlock({ name: '', responsibilities: [''], collaborators: [] }, 999));
  });
  document.getElementById('add-rel').addEventListener('click', () => {
    const noRels = document.getElementById('no-rels');
    if (noRels) noRels.remove();
    document.getElementById('rels').insertAdjacentHTML('beforeend', relBlock({ from: '', to: '', type: 'association', description: '' }, 999));
  });

  document.getElementById('save-draft').addEventListener('click', () => persistDraft(attempt.id, false));
  document.getElementById('submit-attempt').addEventListener('click', () => persistDraft(attempt.id, true));
}

function classBlock(c) {
  return `
    <div class="class-block">
      <div class="class-head">
        <input class="cls-name" placeholder="ClassName" value="${esc(c.name)}" />
        <button class="remove-btn remove-class" title="Remove class">✕</button>
      </div>
      <div class="field">
        <label>Responsibilities (one per line)</label>
        <textarea class="cls-resp" rows="3" placeholder="assigns a free spot to a vehicle&#10;tracks spot occupancy">${esc((c.responsibilities ?? []).join('\n'))}</textarea>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>Collaborators (comma-separated class names)</label>
        <input class="cls-collab" placeholder="Vehicle, ParkingSpot, Ticket" value="${esc((c.collaborators ?? []).join(', '))}" />
      </div>
    </div>`;
}

function relBlock(r) {
  const types = ['inheritance', 'composition', 'aggregation', 'association', 'dependency', 'interface-implementation'];
  return `
    <div class="row-grid rel-row" style="margin-bottom:10px">
      <div class="field"><label>From</label><input class="rel-from" placeholder="ParkingLot" value="${esc(r.from)}" /></div>
      <div class="field"><label>To</label><input class="rel-to" placeholder="ParkingSpot" value="${esc(r.to)}" /></div>
      <div class="field">
        <label>Type</label>
        <select class="rel-type">${types.map((t) => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      <div class="field" style="display:flex; align-items:flex-end; gap:8px">
        <div style="flex:1"><label>Why</label><input class="rel-why" placeholder="lot owns spots" value="${esc(r.description)}" /></div>
        <button class="remove-btn remove-rel" title="Remove relationship">✕</button>
      </div>
    </div>`;
}

function renumber() { /* placeholder: visual order is enough; ids are server-side */ }
function syncRelHint() {
  const rels = document.querySelectorAll('.rel-row');
  if (rels.length === 0) {
    document.getElementById('rels').innerHTML = '<p class="muted small" id="no-rels">No relationships yet.</p>';
  }
}

function collectSubmission() {
  const classes = [...document.querySelectorAll('.class-block')].map((block) => ({
    name: block.querySelector('.cls-name').value.trim(),
    responsibilities: block.querySelector('.cls-resp').value.split('\n').map((s) => s.trim()).filter(Boolean),
    collaborators: block.querySelector('.cls-collab').value.split(',').map((s) => s.trim()).filter(Boolean),
  }));
  const relationships = [...document.querySelectorAll('.rel-row')].map((row) => ({
    from: row.querySelector('.rel-from').value.trim(),
    to: row.querySelector('.rel-to').value.trim(),
    type: row.querySelector('.rel-type').value,
    description: row.querySelector('.rel-why').value.trim(),
  }));
  const rationale = document.getElementById('rationale').value.trim();
  return { classes, relationships, rationale };
}

async function persistDraft(attemptId, thenSubmit) {
  const note = document.getElementById('save-note');
  const submission = collectSubmission();
  try {
    note.textContent = 'Saving…';
    await api(`/api/attempts/${attemptId}`, { method: 'PUT', body: JSON.stringify({ submission }) });
    if (!thenSubmit) {
      note.textContent = `Draft saved at ${new Date().toLocaleTimeString()}`;
      toast('Draft saved.');
      return;
    }
    note.textContent = 'Submitting…';
    await api(`/api/attempts/${attemptId}/submit`, { method: 'POST' });
    viewAttempt(attemptId); // same hash — re-render explicitly
  } catch (error) {
    note.textContent = '';
    toast(error.message, true);
  }
}

/* ---------- SUBMITTED / EVALUATING: poll ---------- */

function renderPolling(attempt, problem) {
  $view.innerHTML = `
    <div class="page-head">
      <h1>${esc(problem?.title ?? attempt.problemId)}</h1>
      <p>Your submission is being evaluated.</p>
    </div>
    <section class="panel">
      <div class="status-badge EVALUATING">Evaluating</div>
      <p class="muted" style="margin-top:14px">
        <span class="spin" style="vertical-align:-3px; margin-right:8px"></span>
        Deterministic checks run immediately; ${'LLM'} commentary (if configured) can take a few seconds. This page refreshes itself.
      </p>
    </section>`;
  pollUntilDone(attempt.id);
}

function pollUntilDone(attemptId) {
  window.pollAbort = false;
  const tick = async () => {
    if (window.pollAbort) return;
    try {
      const { attempt } = await api(`/api/attempts/${attemptId}`);
      if (window.pollAbort) return;
      if (attempt.status === 'EVALUATED' || attempt.status === 'FAILED') return viewAttempt(attemptId);
    } catch { /* transient — keep polling */ }
    setTimeout(tick, 1200);
  };
  setTimeout(tick, 1200);
}

/* ---------- FAILED: recoverable ---------- */

function renderFailed(attempt, problem) {
  $view.innerHTML = `
    <div class="page-head">
      <h1>${esc(problem?.title ?? attempt.problemId)}</h1>
      <p>Evaluation could not complete — your submission is safe.</p>
    </div>
    <section class="panel">
      <div class="status-badge FAILED">Evaluation failed</div>
      <div class="finding"><span class="sev warning">reason</span><span>${esc(attempt.evaluationError ?? 'unknown error')}</span></div>
      <div class="btn-row">
        <button class="btn primary" id="retry">Retry evaluation</button>
        <a class="btn" href="#/problems/${esc(attempt.problemId)}">Start a fresh attempt instead</a>
      </div>
    </section>`;
  document.getElementById('retry').addEventListener('click', async () => {
    try {
      await api(`/api/attempts/${attempt.id}/reevaluate`, { method: 'POST' });
      viewAttempt(attempt.id);
    } catch (error) {
      toast(error.message, true);
    }
  });
}

/* ---------- EVALUATED: feedback ---------- */

async function renderFeedbackStage(attempt, problem) {
  const { feedback } = await api(`/api/attempts/${attempt.id}/feedback`);
  renderFeedback(attempt, problem, feedback);
}

function renderFeedback(attempt, problem, feedback) {
  const verdict = feedback.overallScore >= 80 ? 'good' : feedback.overallScore >= 50 ? 'fair' : 'weak';
  $view.innerHTML = `
    <div class="page-head">
      <h1>${esc(problem?.title ?? feedback.problemId)} — feedback</h1>
      <p>Attempt submitted ${fmtDate(attempt.submittedAt)} · engine: <span class="chip engine">${esc(feedback.engine)}</span></p>
    </div>

    <section class="panel">
      <div class="score-hero">
        <div class="score-ring" style="--pct:${feedback.overallScore}">
          <div class="inner"><span class="score">${feedback.overallScore}</span><span class="of">/ 100</span></div>
        </div>
        <div style="flex:1; min-width:260px">
          <div class="status-badge EVALUATED">Evaluated</div>
          <p class="muted" style="margin-top:10px">
            Verdict: <strong>${verdict === 'good' ? 'solid design' : verdict === 'fair' ? 'reasonable, with clear gaps' : 'needs work'}</strong>.
            Scores are deterministic and reproducible; the evidence below quotes your own submission.
          </p>
          ${feedback.llm?.used
            ? `<p class="small muted">LLM commentary: <strong>on</strong> (${esc(feedback.llm.model)}, advisory only)</p>`
            : `<p class="small muted">LLM commentary: <strong>off</strong> (${esc(feedback.llm?.reason ?? 'not configured')}${feedback.llm?.error ? ` — ${esc(feedback.llm.error)}` : ''}). Set <span class="mono">LLM_API_KEY</span> for reasoning-style coaching.</p>`}
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Requirement coverage</h2>
      <ul class="req-list">
        ${feedback.coverage.map((c) => `
          <li class="${c.level}">
            <span class="req-id">${esc(c.requirementId)}</span>
            <span>${esc(c.text)}</span>
            <span class="coverage-badge ${c.level}">${c.level}</span>
            ${c.evidence ? `<div class="evidence" style="flex-basis:100%">evidence: ${esc(c.evidence)}</div>` : ''}
          </li>`).join('')}
      </ul>
    </section>

    <section class="panel">
      <h2>Dimension scores</h2>
      ${feedback.dimensions.map((d) => `
        <div class="dim-card">
          <div class="dim-head">
            <span class="name">${esc(d.label)}</span>
            <span class="dim-score">${d.score}/100</span>
            <span class="weight">${d.weight}% weight</span>
          </div>
          <div class="score-bar"><div class="fill ${verdictFor(d.score)}" style="width:${d.score}%"></div></div>
          ${(d.findings ?? []).map((f) => `
            <div class="finding">
              <span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
              <span>${esc(f.message)}${f.evidence ? `<div class="evidence">${esc(f.evidence)}</div>` : ''}</span>
            </div>`).join('')}
        </div>`).join('')}
    </section>

    <div class="two-col">
      <section class="panel">
        <h2>Keep doing this</h2>
        <ul class="tick-list good">
          ${(feedback.strengths ?? []).map((s) => `<li><span class="tick">✓</span><span>${esc(s)}</span></li>`).join('') || '<li class="muted">Not enough signal yet — submit a fuller design.</li>'}
        </ul>
      </section>
      <section class="panel">
        <h2>Improve next time</h2>
        <ul class="tick-list bad">
          ${(feedback.improvements ?? []).map((s) => `<li><span class="tick">▲</span><span>${esc(s)}</span></li>`).join('') || '<li class="muted">No specific findings — nice work.</li>'}
        </ul>
      </section>
    </div>

    ${feedback.llm?.used ? `
    <section class="panel">
      <div class="llm-box">
        <h3>Coach commentary (LLM, advisory)</h3>
        <p>${esc(feedback.llm.summary)}</p>
        ${feedback.llm.dimensionNotes ? `
          ${Object.entries(feedback.llm.dimensionNotes).map(([k, v]) => `<p class="small" style="margin-bottom:4px"><strong>${esc(k)}:</strong> ${esc(v)}</p>`).join('')}` : ''}
        ${feedback.llm.strengths?.length ? `<p class="small"><strong>Strengths:</strong> ${feedback.llm.strengths.map(esc).join(' · ')}</p>` : ''}
        ${feedback.llm.improvements?.length ? `<p class="small"><strong>Coaching:</strong> ${feedback.llm.improvements.map(esc).join(' · ')}</p>` : ''}
      </div>
    </section>` : ''}

    <section class="panel">
      <h2>Close the loop</h2>
      <p class="muted">Attempt #${esc(attempt.id)} — feedback stays attached to it forever, so you can compare attempts over time.</p>
      <div class="btn-row">
        <a class="btn primary" href="#/problems/${esc(attempt.problemId)}">Try again with a fresh attempt</a>
        <a class="btn" href="#/history">See my attempt history</a>
        <a class="btn subtle" href="#/">Pick another problem</a>
      </div>
    </section>`;
}

function verdictFor(score) {
  return score >= 80 ? 'good' : score >= 50 ? 'fair' : 'weak';
}

/* ------------------------------------------------------------------ */
/* view: history                                                       */
/* ------------------------------------------------------------------ */

async function viewHistory() {
  const history = await api('/api/learners/me/attempts');
  $view.innerHTML = `
    <div class="page-head">
      <h1>My attempts</h1>
      <p>Every attempt is kept with its feedback — progress over one-shot solving.</p>
    </div>
    <section class="panel">
      ${history.attempts.length ? historyTable(history.attempts) : `
        <div class="empty">
          <div class="big">◎</div>
          <p>No attempts yet.</p>
          <a class="btn primary" href="#/">Pick your first problem</a>
        </div>`}
    </section>`;
}

function historyTable(attempts) {
  return `
    <table class="history">
      <thead><tr>
        <th>Problem</th><th>Status</th><th>Score</th><th>Created</th><th>Evaluated</th><th></th>
      </tr></thead>
      <tbody>
        ${attempts.map((a) => `
          <tr>
            <td><a href="#/problems/${esc(a.problemId)}">${esc(a.problemTitle)}</a></td>
            <td><span class="status-badge ${esc(a.status)}">${esc(a.status)}</span></td>
            <td class="mono">${a.overallScore ?? '—'}</td>
            <td class="muted small">${fmtDate(a.createdAt)}</td>
            <td class="muted small">${fmtDate(a.evaluatedAt)}</td>
            <td><a class="btn subtle" href="#/attempts/${esc(a.id)}">open →</a></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}
