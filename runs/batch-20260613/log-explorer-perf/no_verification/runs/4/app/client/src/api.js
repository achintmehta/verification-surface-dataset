/**
 * API client with request cancellation support.
 *
 * Each call to getLogs() cancels the previous in-flight getLogs() request.
 * This ensures stale responses never overwrite newer results.
 */

export function createApiClient(baseUrl) {
  // Track the current in-flight logs request so we can cancel it
  let currentLogsController = null;

  /**
   * Fetch a window of logs.
   * Returns { total, rows } or null if the request was cancelled.
   */
  async function getLogs({ offset = 0, limit = 100, severity = '', q = '' } = {}) {
    // Cancel any previous in-flight request
    if (currentLogsController) {
      currentLogsController.abort();
    }
    currentLogsController = new AbortController();
    const signal = currentLogsController.signal;

    const params = new URLSearchParams();
    params.set('offset', String(offset));
    params.set('limit',  String(Math.min(limit, 200)));
    if (severity) params.set('severity', severity);
    if (q && q.trim()) params.set('q', q.trim());

    const url = `${baseUrl}/logs?${params.toString()}`;

    try {
      const res = await fetch(url, { signal });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      return data; // { total, rows }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Request was intentionally cancelled — return null sentinel
        return null;
      }
      throw err;
    }
  }

  /**
   * Fetch corpus statistics (total count, per-severity counts).
   */
  async function getStats() {
    const res = await fetch(`${baseUrl}/stats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  return { getLogs, getStats };
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}
