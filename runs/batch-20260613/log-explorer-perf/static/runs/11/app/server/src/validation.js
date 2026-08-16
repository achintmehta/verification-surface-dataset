// Request parameter parsing + validation for the logs endpoint.
import { config, SEVERITIES } from './config.js';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Parse and validate the query params for GET /api/logs.
 * Throws ValidationError on any invalid input.
 * @param {Record<string, any>} query
 * @returns {{offset:number, limit:number, severity:string|undefined, q:string|undefined}}
 */
export function parseLogQuery(query) {
  const { maxLimit, defaultLimit } = config.api;

  // offset
  let offset = 0;
  if (query.offset !== undefined && query.offset !== '') {
    offset = Number(query.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError('offset must be a non-negative integer');
    }
  }

  // limit
  let limit = defaultLimit;
  if (query.limit !== undefined && query.limit !== '') {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ValidationError('limit must be a positive integer');
    }
    if (limit > maxLimit) {
      throw new ValidationError(`limit must not exceed ${maxLimit}`);
    }
  }

  // severity
  let severity;
  if (query.severity !== undefined && query.severity !== '') {
    if (!SEVERITIES.includes(query.severity)) {
      throw new ValidationError(
        `severity must be one of ${SEVERITIES.join(', ')}`
      );
    }
    severity = query.severity;
  }

  // q (free text substring)
  let q;
  if (query.q !== undefined && query.q !== '') {
    if (typeof query.q !== 'string') {
      throw new ValidationError('q must be a string');
    }
    q = query.q;
  }

  return { offset, limit, severity, q };
}
