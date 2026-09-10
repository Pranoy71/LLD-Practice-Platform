/**
 * Router — tiny method + path-pattern matcher (no dependencies).
 *
 * Patterns: '/api/attempts/:id' → params { id } on match.
 * Routes are matched in registration order; the first hit wins, so specific
 * routes must be registered before generic ones.
 *
 * @class Router
 */
export class Router {
  constructor() {
    /** @type {Array<{method: string, segments: string[], handler: Function}>} */
    this.routes = [];
  }

  /**
   * @param {string} method   - HTTP method, uppercase
   * @param {string} pattern  - path pattern like '/api/problems/:id'
   * @param {Function} handler - async (ctx) => response body/status
   */
  add(method, pattern, handler) {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern, handler) { return this.add('GET', pattern, handler); }
  post(pattern, handler) { return this.add('POST', pattern, handler); }
  put(pattern, handler) { return this.add('PUT', pattern, handler); }

  /**
   * @param {string} method
   * @param {string} pathname
   * @returns {{handler: Function, params: object}|null}
   */
  match(method, pathname) {
    const pathSegments = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const params = matchSegments(route.segments, pathSegments);
      if (params) return { handler: route.handler, params };
    }
    return null;
  }
}

function matchSegments(patternSegments, pathSegments) {
  if (patternSegments.length !== pathSegments.length) return null;
  const params = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const pattern = patternSegments[i];
    const actual = decodeURIComponent(pathSegments[i]);
    if (pattern.startsWith(':')) {
      if (!actual) return null;
      params[pattern.slice(1)] = actual;
    } else if (pattern !== actual) {
      return null;
    }
  }
  return params;
}
