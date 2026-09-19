import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion } from '../src/llm.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function resetEnvironment() {
  process.env.VERDA_BASE_URL = 'https://mock.verda.ai';
  process.env.VERDA_API_KEY = 'secret-test-token-xyz';
  process.env.VERDA_MODEL = 'Qwen/Qwen2.5-7B-Instruct';
  globalThis.fetch = originalFetch;
}

test('1. throws clear error when VERDA_BASE_URL or VERDA_API_KEY is missing', async () => {
  resetEnvironment();

  try {
    delete process.env.VERDA_BASE_URL;
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Hello' }]),
      { message: /Missing required environment variable: VERDA_BASE_URL/ }
    );

    process.env.VERDA_BASE_URL = 'https://mock.verda.ai';
    delete process.env.VERDA_API_KEY;
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Hello' }]),
      { message: /Missing required environment variable: VERDA_API_KEY/ }
    );

    process.env.VERDA_API_KEY = 'secret-test-token-xyz';
    await assert.rejects(
      () => chatCompletion([]),
      { message: /messages must be a non-empty array/ }
    );
  } finally {
    resetEnvironment();
  }
});

test('2. successfully sends request and parses OpenAI-compatible response', async () => {
  resetEnvironment();

  let capturedUrl = '';
  let capturedOptions = {};

  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        id: 'chatcmpl-mock123',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'VERDA READY',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 2,
          total_tokens: 10,
        },
      }),
    };
  };

  try {
    const messages = [{ role: 'user', content: 'Reply with exactly: VERDA READY' }];
    const result = await chatCompletion(messages, {
      temperature: 0,
      max_tokens: 10,
      response_format: { type: 'text' },
    });

    // Verify endpoint & headers
    assert.equal(capturedUrl, 'https://mock.verda.ai/v1/chat/completions');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer secret-test-token-xyz');

    // Verify payload
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'Qwen/Qwen2.5-7B-Instruct');
    assert.deepEqual(body.messages, messages);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 10);
    assert.deepEqual(body.response_format, { type: 'text' });

    // Verify return format
    assert.equal(result.text, 'VERDA READY');
    assert.equal(result.model, 'Qwen/Qwen2.5-7B-Instruct');
    assert.deepEqual(result.usage, {
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
    });
  } finally {
    resetEnvironment();
  }
});

test('3. handles non-2xx HTTP responses safely without leaking secrets', async () => {
  resetEnvironment();

  // Test 401 Unauthorized with structured JSON error
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ error: { message: 'Invalid API bearer token' } }),
  });

  try {
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Ping' }]),
      (err) => {
        assert.match(err.message, /LLM request failed with status 401 \(Unauthorized\): Invalid API bearer token/);
        // Ensure secret token is NOT leaked in the error message
        assert.ok(!err.message.includes('secret-test-token-xyz'));
        return true;
      }
    );
  } finally {
    resetEnvironment();
  }

  // Test 500 Internal Server Error with plain text body
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    text: async () => 'vLLM worker crashed due to OOM',
  });

  try {
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Ping' }]),
      { message: /LLM request failed with status 500 \(Internal Server Error\): vLLM worker crashed due to OOM/ }
    );
  } finally {
    resetEnvironment();
  }
});

test('4. handles timeout via AbortController', async () => {
  resetEnvironment();

  globalThis.fetch = async (url, options) => {
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      if (signal.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return reject(err);
      }
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  try {
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Ping' }], { timeoutMs: 20 }),
      { message: /LLM request timed out after 20ms/ }
    );
  } finally {
    resetEnvironment();
  }
});

test('5. rejects malformed JSON or missing choices content', async () => {
  resetEnvironment();

  // Malformed JSON
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => {
      throw new Error('Unexpected token < in JSON at position 0');
    },
  });

  try {
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Ping' }]),
      { message: /LLM returned invalid or malformed JSON response/ }
    );
  } finally {
    resetEnvironment();
  }

  // Missing choices array
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ id: '123', choices: [] }),
  });

  try {
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Ping' }]),
      { message: /LLM response missing expected choices\[0\]\.message\.content/ }
    );
  } finally {
    resetEnvironment();
  }

  // Missing message.content
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      choices: [{ message: { role: 'assistant' } }],
    }),
  });

  try {
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Ping' }]),
      { message: /LLM response missing expected choices\[0\]\.message\.content/ }
    );
  } finally {
    resetEnvironment();
  }
});
