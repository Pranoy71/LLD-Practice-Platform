/**
 * LLMClient — a thin, provider-agnostic chat-completions adapter.
 *
 * Talks to any OpenAI-compatible endpoint (OpenAI, Azure-compatible gateways,
 * Ollama with /v1, Groq, etc.) using only `fetch`:
 *
 *   LLM_API_KEY    any API key          (absent → client reports "not configured")
 *   LLM_BASE_URL   default: https://api.openai.com/v1
 *   LLM_MODEL      default: gpt-4o-mini
 *   LLM_TIMEOUT_MS default: 20000
 *
 * Contract: `complete()` NEVER throws — network/HTTP/parse failures return
 * `null` and the caller decides how to degrade. This is deliberate: LLM
 * enrichment is optional value, never a hard dependency of the product.
 *
 * Injectable via constructor so tests can pass a fake client.
 */
export class LLMClient {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.baseUrl]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {typeof globalThis.fetch} [options.fetchImpl]
   */
  constructor({ apiKey, baseUrl, model, timeoutMs, fetchImpl } = {}) {
    this.apiKey = apiKey ?? process.env.LLM_API_KEY;
    this.baseUrl = (baseUrl ?? process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = model ?? process.env.LLM_MODEL ?? 'gpt-4o-mini';
    this.timeoutMs = Number(timeoutMs ?? process.env.LLM_TIMEOUT_MS ?? 20000);
    this.fetchImpl = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  }

  /** True when an API key is present and fetch is available. */
  get configured() {
    return Boolean(this.apiKey && this.fetchImpl);
  }

  /**
   * Ask the model for a JSON object. Returns the parsed object, or `null`
   * when unconfigured / timed out / HTTP error / unparsable body.
   *
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @returns {Promise<object|null>}
   */
  async completeJSON(systemPrompt, userPrompt) {
    if (!this.configured) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return null;
      return parseLooseJSON(content);
    } catch {
      return null; // timeout, DNS, network — all degrade the same way
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Parse model output that may be wrapped in markdown code fences.
 * Returns null instead of throwing.
 */
function parseLooseJSON(content) {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
