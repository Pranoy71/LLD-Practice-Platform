import { ValidationError } from './errors.js';

/**
 * Relationship types the platform understands.
 *
 * NOTE: the validator does NOT reject unknown types — the evaluator flags
 * them instead. "Accept broadly, judge kindly, explain clearly": a learner
 * using 'has-a' should get feedback, not a rejected submission. This is also
 * what makes adding new formats (diagram-first, code-first) cheap later.
 */
export const RELATIONSHIP_TYPES = Object.freeze([
  'inheritance',
  'composition',
  'aggregation',
  'association',
  'dependency',
  'interface-implementation',
]);

/** Bounds enforced by the validator — the evaluator stays inside them. */
const LIMITS = Object.freeze({
  minClasses: 1,
  maxClasses: 25,
  maxResponsibilitiesPerClass: 8,
  maxRelationships: 30,
  minRationaleChars: 100,
  maxRationaleChars: 8000,
  maxFieldLength: 300,
});

/**
 * Submission — a value object describing a learner's LLD answer.
 *
 * The MVP supports one format: **structured text**. The learner fills three
 * guided sections:
 *   - classes:        [{ name, responsibilities[], collaborators[] }]
 *   - relationships:  [{ from, to, type, description }]
 *   - rationale:      free text explaining trade-offs and alternatives
 *
 * The format is deliberately parse-friendly: every check in the deterministic
 * evaluator works on this structure (plus a text corpus), so evaluation never
 * depends on a specific editor or diagram tool.
 *
 * @class Submission
 */
export class Submission {
  /**
   * @param {object} s
   * @param {Array<{name:string,responsibilities:string[],collaborators:string[]}>} s.classes
   * @param {Array<{from:string,to:string,type:string,description:string}>} s.relationships
   * @param {string} s.rationale
   */
  constructor({ classes, relationships, rationale }) {
    this.classes = classes;
    this.relationships = relationships;
    this.rationale = rationale;
    this.format = 'structured-text';
  }

  /** Set of declared class names, lowercase, for cheap membership checks. */
  get declaredClassNames() {
    return new Set(this.classes.map((c) => c.name.toLowerCase()));
  }

  /**
   * Flattened text corpus used for requirement/keyword matching.
   * Includes class names, responsibilities, collaborators, relationship
   * descriptions and the rationale — evidence can come from anywhere.
   */
  get text() {
    const parts = [];
    for (const c of this.classes) {
      parts.push(c.name, ...c.responsibilities, ...c.collaborators);
    }
    for (const r of this.relationships) {
      parts.push(`${r.from} ${r.type} ${r.to} ${r.description}`);
    }
    parts.push(this.rationale);
    return parts.join(' \n ');
  }

  /**
   * Validate + build from a raw JSON payload.
   *
   * @param {object} raw
   * @returns {Submission}
   * @throws {ValidationError} with a learner-friendly message (first problem only)
   */
  static fromJSON(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ValidationError('Submission must be a JSON object with classes, relationships and rationale.');
    }
    const classes = validateClasses(raw.classes);
    const relationships = validateRelationships(raw.relationships ?? []);
    const rationale = validateRationale(raw.rationale);
    return new Submission({ classes, relationships, rationale });
  }

  /** Plain JSON (API responses, persistence, LLM prompts). */
  toJSON() {
    return {
      format: this.format,
      classes: this.classes,
      relationships: this.relationships,
      rationale: this.rationale,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Field-level validators — keep them small and composable.            */
/* ------------------------------------------------------------------ */

function validateClasses(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('A submission needs at least one class. Add your first class to continue.');
  }
  if (raw.length > LIMITS.maxClasses) {
    throw new ValidationError(`A submission may declare at most ${LIMITS.maxClasses} classes (got ${raw.length}).`);
  }
  const seen = new Set();
  return raw.map((c, i) => {
    const label = `Class #${i + 1}`;
    if (!c || typeof c !== 'object') throw new ValidationError(`${label} must be an object with name and responsibilities.`);
    const name = cleanString(c.name, `${label} name`);
    if (!name) throw new ValidationError(`${label} needs a name.`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ValidationError(`Two classes are named '${name}'. Class names must be unique.`);
    seen.add(key);

    const responsibilities = validateStringArray(c.responsibilities, `${label} responsibilities`, 1, LIMITS.maxResponsibilitiesPerClass);
    if (responsibilities.length === 0) {
      throw new ValidationError(`${label} ('${name}') needs at least one responsibility.`);
    }
    const collaborators = validateStringArray(c.collaborators ?? [], `'${name}' collaborators`, 0, LIMITS.maxClasses);

    return { name, responsibilities, collaborators };
  });
}

function validateRelationships(raw) {
  if (!Array.isArray(raw)) {
    throw new ValidationError('Relationships must be an array (it can be empty).');
  }
  if (raw.length > LIMITS.maxRelationships) {
    throw new ValidationError(`A submission may declare at most ${LIMITS.maxRelationships} relationships.`);
  }
  return raw.map((r, i) => {
    const label = `Relationship #${i + 1}`;
    if (!r || typeof r !== 'object') {
      throw new ValidationError(`${label} must be an object with from, to, type and description.`);
    }
    const from = cleanString(r.from, `${label} 'from' class`);
    const to = cleanString(r.to, `${label} 'to' class`);
    const type = cleanString(r.type, `${label} type`);
    const description = cleanString(r.description, `${label} description`);
    if (!from || !to) throw new ValidationError(`${label} needs both a 'from' and a 'to' class.`);
    if (!type) throw new ValidationError(`${label} needs a type (e.g. ${RELATIONSHIP_TYPES.slice(0, 3).join(', ')}...).`);
    return { from, to, type, description: description ?? '' };
  });
}

function validateRationale(raw) {
  const rationale = typeof raw === 'string' ? raw.trim() : '';
  if (rationale.length < LIMITS.minRationaleChars) {
    throw new ValidationError(
      `The design rationale needs at least ${LIMITS.minRationaleChars} characters — explain *why* you made your key choices.`
    );
  }
  if (rationale.length > LIMITS.maxRationaleChars) {
    throw new ValidationError(`The rationale is limited to ${LIMITS.maxRationaleChars} characters.`);
  }
  return rationale;
}

function validateStringArray(raw, label, min, max) {
  if (raw == null) raw = [];
  if (!Array.isArray(raw)) throw new ValidationError(`${label} must be a list of strings.`);
  if (raw.length > max) throw new ValidationError(`${label} may contain at most ${max} entries.`);
  const cleaned = raw
    .map((s) => cleanString(s, label))
    .filter((s) => s !== null);
  if (cleaned.length < min) {
    throw new ValidationError(
      `${label} needs at least ${min} entr${min === 1 ? 'y' : 'ies'} after removing empty ones.`
    );
  }
  return cleaned;
}

function cleanString(value, label) {
  if (typeof value !== 'string') {
    if (value == null) return null;
    throw new ValidationError(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > LIMITS.maxFieldLength) {
    throw new ValidationError(`${label} is too long (max ${LIMITS.maxFieldLength} characters).`);
  }
  return trimmed === '' ? null : trimmed;
}
