#!/usr/bin/env node

import { initDatabase } from './db.js';
import { embedCorpusChunks, DEFAULT_MODEL_NAME } from './embeddings.js';

/**
 * CLI runner for `npm run embed`.
 * Generates local semantic embeddings for all un-embedded chunks in the database.
 */
async function main() {
  console.log('===============================================================');
  console.log('  Memory With a Receipt — Local Semantic Embeddings');
  console.log(`  Model: ${DEFAULT_MODEL_NAME} (Local ONNX/Transformers)`);
  console.log('===============================================================\n');

  const db = initDatabase('data/memory.db');

  try {
    const startTime = Date.now();

    const result = await embedCorpusChunks(db, {
      batchSize: 32,
      onProgress: (current, missingTotal, totalChunks) => {
        const percent = ((current / missingTotal) * 100).toFixed(1);
        process.stdout.write(`\r  Embedding progress: ${current}/${missingTotal} un-embedded chunks (${percent}%) | Total corpus chunks: ${totalChunks}`);
      },
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n');
    console.log('--- EMBEDDING SUMMARY ---');
    console.log(`  • Model Used:            ${result.modelName}`);
    console.log(`  • Total Corpus Chunks:   ${result.totalChunks}`);
    console.log(`  • Newly Embedded:        ${result.newEmbeddedCount}`);
    console.log(`  • Skipped (Already Done):${result.skippedCount}`);
    console.log(`  • Elapsed Time:          ${elapsed}s\n`);

    console.log('===============================================================');
    console.log('  Embedding generation completed successfully.');
    console.log('===============================================================');
  } catch (err) {
    console.error('\nFatal embedding error:', err);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
