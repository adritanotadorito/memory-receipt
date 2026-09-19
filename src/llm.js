/**
 * ============================================================================
 * OPENAI INFERENCE CLIENT (PHASE 5A)
 * ============================================================================
 *
 * Lightweight, zero-dependency client connecting to OpenAI Chat Completions API.
 *
 * Safety & Grounding Principles:
 * 1. Secrets & Credentials:
 *    - Never logged, printed, or exposed in error messages or audit dumps.
 * 2. Timeout & Resource Guard:
 *    - Strict 60-second AbortController timeout prevents hanging requests.
 * 3. Validation:
 *    - Verifies API key, messages, HTTP status, and response structure.
 * ============================================================================
 */

export const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_FALLBACK_MODEL = 'gpt-4.1-mini';

/**
 * Sends a chat completion request to the OpenAI API.
 *
 * @param {Array<{ role: 'system' | 'user' | 'assistant', content: string }>} messages
 * @param {object} [options]
 * @param {string} [options.model] - Override model name
 * @param {number} [options.temperature] - Sampling temperature (e.g. 0.0 for deterministic output)
 * @param {number} [options.max_tokens] - Max tokens to generate (or maxTokens)
 * @param {number} [options.maxTokens]
 * @param {object} [options.response_format] - Structured output format (or responseFormat)
 * @param {object} [options.responseFormat]
 * @param {number} [options.timeoutMs=60000] - Request timeout in milliseconds
 * @returns {Promise<{
 *   text: string,
 *   usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number },
 *   model: string
 * }>}
 */
export async function chatCompletion(messages, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  // 1. Validate configuration
  if (!apiKey) {
    throw new Error('Missing required environment variable: OPENAI_API_KEY');
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array of message objects');
  }

  const model = options.model || process.env.OPENAI_MODEL?.trim() || DEFAULT_FALLBACK_MODEL;
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  // 2. Build OpenAI chat completions request payload
  const payload = {
    model,
    messages,
  };

  if (typeof options.temperature === 'number') {
    payload.temperature = options.temperature;
  }

  const maxTokens = options.max_tokens ?? options.maxTokens;
  if (typeof maxTokens === 'number') {
    payload.max_tokens = maxTokens;
  }

  const responseFormat = options.response_format ?? options.responseFormat;
  if (responseFormat && typeof responseFormat === 'object') {
    payload.response_format = responseFormat;
  }

  // 3. Prepare Timeout & Request
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let response;
  try {
    response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`LLM network request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // 4. Handle non-2xx HTTP responses without leaking credentials or prompts
  if (!response.ok) {
    let errorDetails = '';
    try {
      const errorBody = await response.text();
      try {
        const parsed = JSON.parse(errorBody);
        errorDetails = parsed.error?.message || parsed.message || errorBody.slice(0, 200);
      } catch {
        errorDetails = errorBody.slice(0, 200);
      }
    } catch {
      errorDetails = 'Unable to read error response body';
    }

    throw new Error(`LLM request failed with status ${response.status} (${response.statusText}): ${errorDetails}`);
  }

  // 5. Parse response JSON
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('LLM returned invalid or malformed JSON response');
  }

  // 6. Validate choices and message content
  if (
    !data ||
    !Array.isArray(data.choices) ||
    data.choices.length === 0 ||
    !data.choices[0]?.message ||
    typeof data.choices[0].message.content !== 'string'
  ) {
    throw new Error('LLM response missing expected choices[0].message.content');
  }

  return {
    text: data.choices[0].message.content,
    usage: {
      prompt_tokens: Number(data.usage?.prompt_tokens ?? 0),
      completion_tokens: Number(data.usage?.completion_tokens ?? 0),
      total_tokens: Number(data.usage?.total_tokens ?? 0),
    },
    model: data.model || model,
  };
}
