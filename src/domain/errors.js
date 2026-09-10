/**
 * Domain errors.
 *
 * Every error carries a stable `code` so the HTTP layer can map failures to
 * status codes without `instanceof` chains scattered across controllers.
 */
export class DomainError extends Error {
  /**
   * @param {string} message - human-readable explanation (safe to show to a learner)
   * @param {string} code    - machine-readable code, e.g. 'VALIDATION'
   */
  constructor(message, code) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

/** Thrown when input (typically a submission payload) is malformed. */
export class ValidationError extends DomainError {
  constructor(message) {
    super(message, 'VALIDATION');
    this.status = 400;
  }
}

/** Thrown when an attempt transitions between states illegally. */
export class InvalidTransitionError extends DomainError {
  constructor(from, to) {
    super(`Cannot move attempt from '${from}' to '${to}'.`, 'INVALID_TRANSITION');
    this.status = 409;
  }
}

/** Thrown when a requested entity does not exist. */
export class NotFoundError extends DomainError {
  constructor(entity, id) {
    super(`${entity} '${id}' was not found.`, 'NOT_FOUND');
    this.status = 404;
  }
}
