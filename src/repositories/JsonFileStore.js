import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * JsonFileStore — minimal durable persistence for the MVP.
 *
 * Design notes:
 *  - Write-through with atomic replace (unique tmp file + rename), so a
 *    crash mid-write can never corrupt the previous state.
 *  - Concurrent `save()` calls are serialised on an internal chain: each
 *    write waits for the previous one, which (a) avoids tmp-file races and
 *    (b) guarantees the file on disk ends up as the LATEST full snapshot.
 *  - The repositories in front of this store are the real seams: swap
 *    `JsonFileStore` for Postgres/Mongo later without touching domain or
 *    service code.
 *  - Synchronous read at construction (boot), async writes afterwards.
 */
export class JsonFileStore {
  /**
   * @param {string} filePath - absolute path of the JSON file
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.load();
    /** @type {Promise<void>} tail of the write chain */
    this.writeChain = Promise.resolve();
  }

  /** Read the file if it exists; otherwise start empty (callers decide defaults). */
  load() {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      return null; // missing or unreadable → fresh start
    }
  }

  /**
   * Persist `data`. Atomic + ordered under concurrency.
   * @param {object} data
   */
  save(data) {
    // Queue this write behind any in-flight write (order = call order).
    const perform = async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
      this.data = data;
    };
    this.writeChain = this.writeChain.then(perform, perform);
    return this.writeChain;
  }
}
