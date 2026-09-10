import { EvaluationEngine } from './EvaluationEngine.js';
import { FeedbackReport, verdictFor } from '../domain/FeedbackReport.js';

/* ------------------------------------------------------------------ */
/* Tunable heuristics — deliberately conservative. The goal is *useful  */
/* signals with evidence*, not a fake "correct answer" oracle.          */
/* ------------------------------------------------------------------ */
const HEURISTICS = Object.freeze({
  minClasses: 3,
  manyClasses: 12,
  godClassResponsibilities: 6,
  criticalGodClassResponsibilities: 8,
  minTradeoffMentions: 3,
  shortRationaleChars: 300,
  /** penalty points per finding severity, applied to that dimension */
  penalty: { critical: 35, warning: 12, info: 4 },
});

const TRADE_OFF_VOCAB = [
  'solid', 'coupling', 'cohesion', 'extensib', 'maintainab', 'trade-off', 'tradeoff',
  'strategy', 'observer', 'factory', 'singleton', 'state machine', 'command',
  'decorator', 'template method', 'open-closed', 'polymorphis', 'abstraction',
  'encapsulat', 'instead of', 'rather than', 'alternative', 'because', 'why',
];

const EXTENSIBILITY_SIGNALS = [
  'interface', 'abstract', 'implement', 'polymorphis', 'open-closed',
  'extensib', 'plug', 'strategy', 'hook', 'subclass',
];

const DEFAULT_RUBRIC = [
  { key: 'requirement-coverage', label: 'Requirement coverage', weight: 30 },
  { key: 'class-design', label: 'Class design', weight: 25 },
  { key: 'relationships', label: 'Relationships', weight: 20 },
  { key: 'rationale-and-tradeoffs', label: 'Rationale & trade-offs', weight: 15 },
  { key: 'extensibility', label: 'Extensibility', weight: 10 },
];

/**
 * RubricEvaluationEngine — fully deterministic evaluator.
 *
 * Answers the assignment question "which parts of evaluation should be
 * deterministic?" for this MVP: coverage, structure and smell checks are
 * rule-based so every learner gets the same treatment, and every finding
 * quotes evidence from their own submission. LLM reasoning is layered ON TOP
 * (see LLMAugmentationEngine), never replacing the reproducible baseline.
 *
 * @class RubricEvaluationEngine
 * @extends EvaluationEngine
 */
export class RubricEvaluationEngine extends EvaluationEngine {
  /**
   * @param {object} [options]
   * @param {() => string} [options.idGenerator]
   * @param {() => string} [options.now]
   */
  constructor({ idGenerator = defaultIdGenerator, now = () => new Date().toISOString() } = {}) {
    super();
    this.idGenerator = idGenerator;
    this.now = now;
  }

  /**
   * @param {import('../domain/Attempt.js').Attempt} attempt
   * @param {import('../domain/Problem.js').Problem} problem
   * @returns {Promise<import('../domain/FeedbackReport.js').FeedbackReport>}
   */
  async evaluate(attempt, problem) {
    const submission = attempt.submission;
    if (!submission) throw new Error(`Attempt ${attempt.id} has no submission to evaluate.`);

    const sentences = splitSentences(submission.text);
    const strengths = [];

    const coverageResult = checkRequirementCoverage(problem, submission, sentences);
    const classResult = checkClassDesign(submission);
    const relationResult = checkRelationships(submission);
    const rationaleResult = checkRationale(submission);
    const extResult = checkExtensibility(submission);

    strengths.push(...coverageResult.strengths, ...classResult.strengths, ...relationResult.strengths,
      ...rationaleResult.strengths, ...extResult.strengths);

    const rubric = mergeRubric(problem.rubric);
    const dimensionResults = {
      'requirement-coverage': coverageResult,
      'class-design': classResult,
      'relationships': relationResult,
      'rationale-and-tradeoffs': rationaleResult,
      'extensibility': extResult,
    };

    const dimensions = rubric.map((criterion) => {
      const result = dimensionResults[criterion.key];
      // Coverage is ratio-based (the dimension IS the coverage ratio);
      // everything else is penalty-based around a healthy baseline of 100.
      const score = criterion.key === 'requirement-coverage'
        ? result.score
        : scoreOf(result.findings);
      return {
        key: criterion.key,
        label: criterion.label,
        weight: criterion.weight,
        score,
        maxScore: 100,
        verdict: verdictFor(score),
        findings: result.findings,
      };
    });

    const overallScore = Math.round(
      dimensions.reduce((sum, d) => sum + (d.score * d.weight) / 100, 0)
    );

    const improvements = collectImprovements(dimensions);

    return new FeedbackReport({
      id: this.idGenerator('fb'),
      attemptId: attempt.id,
      problemId: problem.id,
      engine: 'deterministic',
      overallScore,
      dimensions,
      coverage: coverageResult.coverage,
      strengths: dedupe(strengths).slice(0, 6),
      improvements,
      llm: { used: false, reason: 'not-configured' },
      generatedAt: this.now(),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Dimension checks. Each returns { findings[], strengths?, coverage? } */
/* ------------------------------------------------------------------ */

function checkRequirementCoverage(problem, submission, sentences) {
  const findings = [];
  const coverage = [];
  let coveredCount = 0;
  let partialCount = 0;

  for (const req of problem.requirements) {
    const matched = matchKeywords(req.keywords, sentences);
    const ratio = matched.keywordsHit / req.keywords.length;
    const level = matched.keywordsHit === 0 ? 'none' : req.keywords.length === 1 || ratio >= 0.5 ? 'full' : 'partial';
    if (level === 'full') coveredCount++;
    if (level === 'partial') partialCount++;

    coverage.push({
      requirementId: req.id,
      text: req.text,
      level,
      matchedKeywords: matched.keywordsHitList,
      evidence: matched.evidence,
    });

    if (level === 'none') {
      findings.push({
        severity: 'warning',
        message: `Requirement "${short(req.text)}" is not visibly addressed. Check whether a class or relationship should own it.`,
        evidence: null,
      });
    } else if (level === 'partial') {
      findings.push({
        severity: 'info',
        message: `Requirement "${short(req.text)}" is only partly addressed (${matched.keywordsHit}/${req.keywords.length} key concepts found).`,
        evidence: matched.evidence,
      });
    }
  }

  const strengths = [];
  if (coveredCount === problem.requirements.length) {
    strengths.push('Every stated requirement shows up somewhere in your design — good coverage discipline.');
  } else if (coveredCount >= Math.ceil(problem.requirements.length / 2)) {
    strengths.push(`Most requirements (${coveredCount}/${problem.requirements.length}) are visibly addressed.`);
  }
  // Ratio-based score: full = 1.0, partial = 0.5, none = 0.
  const score = Math.round(((coveredCount + 0.5 * partialCount) / problem.requirements.length) * 100);
  return { findings, strengths, coverage, score, coveredCount, partialCount };
}

function checkClassDesign(submission) {
  const findings = [];
  const strengths = [];
  const { classes } = submission;
  const declared = submission.declaredClassNames;

  if (classes.length < HEURISTICS.minClasses) {
    findings.push({
      severity: 'critical',
      message: `Only ${classes.length} class${classes.length === 1 ? '' : 'es'} declared. LLD answers need cooperating classes — responsibilities, relationships and interfaces have nowhere to live in a single class.`,
      evidence: null,
    });
  } else if (classes.length > HEURISTICS.manyClasses) {
    findings.push({
      severity: 'info',
      message: `${classes.length} classes is on the high side. Check whether some of them share one responsibility and could merge.`,
      evidence: null,
    });
  } else {
    strengths.push(`Class count (${classes.length}) is in a healthy range for this problem size.`);
  }

  for (const c of classes) {
    const godSeverity =
      c.responsibilities.length >= HEURISTICS.criticalGodClassResponsibilities ? 'critical'
      : c.responsibilities.length > HEURISTICS.godClassResponsibilities ? 'warning'
      : null;
    if (godSeverity) {
      findings.push({
        severity: godSeverity,
        message: `'${c.name}' has ${c.responsibilities.length} responsibilities — a "god class" smell. Try to split it by role.`,
        evidence: `${c.name}: ${c.responsibilities.join('; ')}`,
      });
    }
    for (const collab of c.collaborators) {
      if (!declared.has(collab.toLowerCase())) {
        findings.push({
          severity: 'warning',
          message: `'${c.name}' collaborates with '${collab}', which is not declared as a class. Declare it (or fix the name) so the design is self-consistent.`,
          evidence: `${c.name} -> ${collab}`,
        });
      }
    }
    if (/[a-z]/.test(c.name[0]) || /\s/.test(c.name)) {
      findings.push({
        severity: 'info',
        message: `Class name '${c.name}' reads more clearly as a PascalCase noun (e.g. '${toPascal(c.name)}').`,
        evidence: c.name,
      });
    }
  }
  return { findings, strengths };
}

function checkRelationships(submission) {
  const findings = [];
  const strengths = [];
  const { classes, relationships } = submission;
  const declared = submission.declaredClassNames;

  if (relationships.length === 0) {
    findings.push({
      severity: 'warning',
      message: 'No relationships declared. LLD quality lives mostly in how classes connect — add the key ones.',
      evidence: null,
    });
  }

  const dangling = [];
  for (const r of relationships) {
    for (const side of [r.from, r.to]) {
      if (!declared.has(side.toLowerCase())) dangling.push(side);
    }
    if (r.type && !isKnownType(r.type)) {
      findings.push({
        severity: 'info',
        message: `Relationship type '${r.type}' is non-standard. Common types: inheritance, composition, aggregation, association, dependency, interface-implementation.`,
        evidence: relLabel(r),
      });
    }
    if (r.from.toLowerCase() === r.to.toLowerCase()) {
      findings.push({
        severity: 'info',
        message: `Self-relationship on '${r.from}' — intentional (e.g. a linked list) or a modelling slip?`,
        evidence: relLabel(r),
      });
    }
  }
  if (dangling.length > 0) {
    const mostlyDangling = relationships.length > 0 && dangling.length >= relationships.length;
    findings.push({
      severity: mostlyDangling ? 'critical' : 'warning',
      message: `These relationship endpoints are not declared classes: ${[...new Set(dangling)].join(', ')}. Every relationship should connect two declared classes.`,
      evidence: null,
    });
  }

  const minExpected = Math.max(1, Math.ceil(classes.length / 3));
  if (relationships.length > 0 && relationships.length < minExpected) {
    findings.push({
      severity: 'info',
      message: `Only ${relationships.length} relationship${relationships.length === 1 ? '' : 's'} for ${classes.length} classes — parts of the design look disconnected.`,
      evidence: null,
    });
  } else if (relationships.length >= classes.length - 1 && dangling.length === 0) {
    strengths.push('Your classes are well connected and every relationship endpoint is declared.');
  }
  return { findings, strengths };
}

function checkRationale(submission) {
  const findings = [];
  const strengths = [];
  const rationale = submission.rationale;

  if (rationale.length < HEURISTICS.shortRationaleChars) {
    findings.push({
      severity: 'warning',
      message: `The rationale is short (${rationale.length} chars). Reviewers read it to understand your intent — walk through the 2–3 decisions you are least sure about.`,
      evidence: short(rationale),
    });
  }

  const hits = TRADE_OFF_VOCAB.filter((v) => submission.text.toLowerCase().includes(v));
  if (hits.length === 0) {
    findings.push({
      severity: 'warning',
      message: 'No trade-off language found (coupling, cohesion, alternatives, "instead of"...). Say why you chose this shape over another.',
      evidence: null,
    });
  } else if (hits.length < HEURISTICS.minTradeoffMentions) {
    findings.push({
      severity: 'warning',
      message: `Trade-off reasoning is thin — found "${hits.join('", "')}". Name at least one alternative you rejected and why.`,
      evidence: null,
    });
  } else {
    strengths.push(`Rationale engages with trade-offs ("${hits.slice(0, 3).join('", "')}"...).`);
  }
  return { findings, strengths };
}

function checkExtensibility(submission) {
  const findings = [];
  const strengths = [];
  const text = submission.text.toLowerCase();

  const declaredSignals = submission.relationships.filter((r) =>
    r.type === 'interface-implementation' || r.type === 'inheritance'
  );
  const vocabSignals = EXTENSIBILITY_SIGNALS.filter((v) => text.includes(v));

  const total = declaredSignals.length + vocabSignals.length;
  if (total === 0) {
    findings.push({
      severity: 'warning',
      message: 'No extension points found. Where behaviour can vary (pricing, scheduling, strategy...), an interface or abstract parent usually earns its keep.',
      evidence: null,
    });
  } else if (total >= 2) {
    strengths.push('Design shows explicit extension points (interfaces / abstraction / polymorphism).');
  } else {
    findings.push({
      severity: 'info',
      message: 'Only one extensibility signal found — consider where the next requirement would force a change today.',
      evidence: null,
    });
  }
  return { findings, strengths };
}

/* ------------------------------------------------------------------ */
/* Matching helpers                                                     */
/* ------------------------------------------------------------------ */

/** Split the corpus into sentences so evidence quotes stay meaningful. */
function splitSentences(text) {
  return text
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
}

function tokenize(str) {
  return String(str).toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Tolerant word equality: singular/plural forms count as the same concept. */
function sameWord(a, b) {
  if (a === b) return true;
  if (a + 's' === b || a + 'es' === b) return true;
  if (b + 's' === a || b + 'es' === a) return true;
  return false;
}

/**
 * Match a requirement's keywords against the corpus, sentence by sentence.
 * Returns how many keywords hit, which ones, and the best evidence sentence.
 */
function matchKeywords(keywords, sentences) {
  const sentenceTokens = sentences.map((s) => ({ raw: s, tokens: new Set(tokenize(s)) }));
  const keywordsHitList = [];
  let evidence = null;
  let evidenceScore = 0;

  for (const keyword of keywords) {
    const words = tokenize(keyword);
    let hit = false;
    for (const sentence of sentenceTokens) {
      const wordsPresent = words.every((w) => [...sentence.tokens].some((t) => sameWord(t, w)));
      if (wordsPresent) {
        hit = true;
        const score = words.length + 1;
        if (score > evidenceScore) {
          evidenceScore = score;
          evidence = sentence.raw.length > 220 ? sentence.raw.slice(0, 217) + '...' : sentence.raw;
        }
        break; // one evidence sentence per keyword is enough
      }
    }
    // Whole-corpus fallback: all keyword words exist but never in one sentence.
    if (!hit && sentences.length > 0) {
      const all = new Set();
      for (const s of sentenceTokens) for (const t of s.tokens) all.add(t);
      hit = words.length > 0 && words.every((w) => [...all].some((t) => sameWord(t, w)));
      if (hit && !evidence) {
        evidence = `Mentioned across your submission: ${words.join(' ')}`;
      }
    }
    if (hit) keywordsHitList.push(keyword);
  }

  return { keywordsHit: keywordsHitList.length, keywordsHitList, evidence };
}

/* ------------------------------------------------------------------ */
/* Scoring + report assembly helpers                                    */
/* ------------------------------------------------------------------ */

function scoreOf(findings) {
  let score = 100;
  for (const f of findings) {
    score -= HEURISTICS.penalty[f.severity] ?? 0;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function mergeRubric(problemRubric) {
  const byKey = new Map(DEFAULT_RUBRIC.map((c) => [c.key, { ...c }]));
  for (const criterion of problemRubric ?? []) {
    if (byKey.has(criterion.key)) {
      byKey.set(criterion.key, { ...byKey.get(criterion.key), ...criterion });
    } else {
      byKey.set(criterion.key, criterion);
    }
  }
  const merged = [...byKey.values()];
  const total = merged.reduce((s, c) => s + c.weight, 0);
  if (total > 0 && total !== 100) {
    const scale = 100 / total;
    merged.forEach((c) => (c.weight = Math.round(c.weight * scale * 100) / 100));
  }
  return merged;
}

function collectImprovements(dimensions) {
  const order = { critical: 0, warning: 1, info: 2 };
  const all = [];
  for (const d of dimensions) for (const f of d.findings) all.push({ ...f, dimension: d.label });
  return all
    .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
    .slice(0, 6)
    .map((f) => f.message);
}

function relLabel(r) {
  return `${r.from} --${r.type}--> ${r.to}${r.description ? `: ${short(r.description)}` : ''}`;
}

function short(text, max = 110) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function toPascal(name) {
  return name
    .split(/[\s_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function dedupe(items) {
  return [...new Set(items)];
}

function isKnownType(type) {
  const normalized = type.toLowerCase().replace(/[\s_-]+/g, '-');
  return [
    'inheritance', 'composition', 'aggregation', 'association', 'dependency', 'interface-implementation',
  ].includes(normalized);
}

function defaultIdGenerator(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)}`;
}
