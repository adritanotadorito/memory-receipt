import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, OPENAI_ENDPOINT } from '../src/llm.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function resetEnvironment() {
  process.env.OPENAI_API_KEY = 'sk-mock-key-12345';
  process.env.OPENAI_MODEL = 'gpt-4.1-mini';
  globalThis.fetch = originalFetch;
}

test('1. throws clear error when OPENAI_API_KEY is missing or messages are empty', async () => {
  resetEnvironment();

  try {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Hello' }]),
      { message: /Missing required environment variable: OPENAI_API_KEY/ }
    );

    process.env.OPENAI_API_KEY = 'sk-mock-key-12345';
    await assert.rejects(
      () => chatCompletion([]),
      { message: /messages must be a non-empty array/ }
    );
  } finally {
    resetEnvironment();
  }
});

test('2. successfully sends request and parses OpenAI response', async () => {
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
        model: 'gpt-4.1-mini',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'OPENAI READY',
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
    const messages = [{ role: 'user', content: 'Reply with exactly: OPENAI READY' }];
    const result = await chatCompletion(messages, {
      temperature: 0,
      max_tokens: 10,
      response_format: { type: 'text' },
    });

    assert.equal(capturedUrl, OPENAI_ENDPOINT);
    assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer sk-mock-key-12345');

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'gpt-4.1-mini');
    assert.deepEqual(body.messages, messages);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 10);
    assert.deepEqual(body.response_format, { type: 'text' });

    assert.equal(result.text, 'OPENAI READY');
    assert.equal(result.model, 'gpt-4.1-mini');
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

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
  });

  try {
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Ping' }]),
      (err) => {
        assert.match(err.message, /LLM request failed with status 401 \(Unauthorized\): Incorrect API key provided/);

        assert.ok(!err.message.includes('sk-mock-key-12345'));
        return true;
      }
    );
  } finally {
    resetEnvironment();
  }

  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    text: async () => 'OpenAI server overload',
  });

  try {
    await assert.rejects(
      () => chatCompletion([{ role: 'user', content: 'Ping' }]),
      { message: /LLM request failed with status 500 \(Internal Server Error\): OpenAI server overload/ }
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
