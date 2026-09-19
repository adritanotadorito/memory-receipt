#!/usr/bin/env node
import { chatCompletion } from './llm.js';

/**
 * Health check CLI script for the Verda vLLM endpoint.
 * Sends a minimal prompt and verifies connectivity, latency, and response format.
 */
async function main() {
  console.log('\n========================================');
  console.log('       VERDA LLM HEALTH CHECK');
  console.log('========================================');
  console.log(`Endpoint:   ${process.env.VERDA_BASE_URL || '(not set)'}`);
  console.log(`Model:      ${process.env.VERDA_MODEL || 'Qwen/Qwen2.5-7B-Instruct'}`);
  console.log('----------------------------------------');
  console.log('Sending test prompt: "Reply with exactly: VERDA READY" ...\n');

  const startTime = Date.now();

  try {
    const result = await chatCompletion(
      [{ role: 'user', content: 'Reply with exactly: VERDA READY' }],
      {
        temperature: 0,
        max_tokens: 10,
      }
    );

    const elapsedMs = Date.now() - startTime;

    console.log('✅ Verda vLLM Health Check: SUCCESS');
    console.log(`Response Text:     ${JSON.stringify(result.text.trim())}`);
    console.log(`Model Reported:    ${result.model}`);
    console.log(`Prompt Tokens:     ${result.usage.prompt_tokens}`);
    console.log(`Completion Tokens: ${result.usage.completion_tokens}`);
    console.log(`Total Tokens:      ${result.usage.total_tokens}`);
    console.log(`Roundtrip Time:    ${elapsedMs}ms`);
    console.log('========================================\n');
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    console.error('❌ Verda vLLM Health Check: FAILED');
    console.error(`Error:             ${err.message}`);
    console.error(`Elapsed Time:      ${elapsedMs}ms`);
    console.error('========================================\n');
    process.exit(1);
  }
}

main();
