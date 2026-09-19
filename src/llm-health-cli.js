#!/usr/bin/env node
import { chatCompletion, OPENAI_ENDPOINT } from './llm.js';

/**
 * Health check CLI script for OpenAI Chat Completions API.
 * Sends a minimal prompt and verifies connectivity, latency, and response format.
 */
async function main() {
  console.log('\n========================================');
  console.log('       OPENAI LLM HEALTH CHECK');
  console.log('========================================');
  console.log(`Endpoint:        ${OPENAI_ENDPOINT}`);
  console.log(`Model:           ${process.env.OPENAI_MODEL || 'gpt-4.1-mini'}`);
  console.log('----------------------------------------');
  console.log('Sending test prompt: "Reply with exactly: OPENAI READY" ...\n');

  const startTime = Date.now();

  try {
    const result = await chatCompletion(
      [{ role: 'user', content: 'Reply with exactly: OPENAI READY' }],
      {
        temperature: 0,
        max_tokens: 10,
      }
    );

    const elapsedMs = Date.now() - startTime;

    console.log('✅ OpenAI LLM Health Check: SUCCESS');
    console.log(`Response Text:     ${JSON.stringify(result.text.trim())}`);
    console.log(`Model Reported:    ${result.model}`);
    console.log(`Prompt Tokens:     ${result.usage.prompt_tokens}`);
    console.log(`Completion Tokens: ${result.usage.completion_tokens}`);
    console.log(`Total Tokens:      ${result.usage.total_tokens}`);
    console.log(`Roundtrip Time:    ${elapsedMs}ms`);
    console.log('========================================\n');
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    console.error('❌ OpenAI LLM Health Check: FAILED');
    console.error(`Error:             ${err.message}`);
    console.error(`Elapsed Time:      ${elapsedMs}ms`);
    console.error('========================================\n');
    process.exit(1);
  }
}

main();
