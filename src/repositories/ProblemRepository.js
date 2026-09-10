import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Problem } from '../domain/Problem.js';

/**
 * ProblemRepository — read-only catalogue of LLD problems.
 *
 * Source of truth: `data/problems/*.json` seed files. Problems are
 * curriculum, not user state, so they are loaded at boot and never written.
 * A future admin flow would get its own repository, not write-through here.
 *
 * @class ProblemRepository
 */
export class ProblemRepository {
  /**
   * @param {string} seedDir - directory containing *.json seed files
   */
  constructor(seedDir) {
    this.seedDir = seedDir;
    /** @type {Map<string, Problem>} keyed by id */
    this.byId = new Map();
    this.seeded = false;
  }

  /**
   * Load and validate every seed file. Called at boot; fails loudly on bad
   * seeds (a broken curriculum should stop the server, not silently ship).
   */
  async loadSeeds() {
    let files = [];
    try {
      files = await fs.readdir(this.seedDir);
    } catch (err) {
      throw new Error(`Problem seed directory '${this.seedDir}' could not be read: ${err.message}`);
    }
    const seedFiles = files.filter((f) => f.endsWith('.json')).sort();
    if (seedFiles.length === 0) {
      throw new Error(`No problem seed files found in '${this.seedDir}'.`);
    }
    for (const file of seedFiles) {
      const raw = JSON.parse(await fs.readFile(join(this.seedDir, file), 'utf8'));
      const problem = Problem.fromJSON(raw);
      if (this.byId.has(problem.id)) {
        throw new Error(`Duplicate problem id '${problem.id}' in seed files.`);
      }
      this.byId.set(problem.id, problem);
    }
    this.seeded = true;
    return this.byId.size;
  }

  /** @returns {Problem[]} all problems, insertion order (alphabetical by file). */
  list() {
    return [...this.byId.values()];
  }

  /**
   * Look a problem up by id.
   * @param {string} id
   * @returns {Problem|null}
   */
  get(id) {
    return this.byId.get(id) ?? null;
  }

  get count() {
    return this.byId.size;
  }
}
