#!/usr/bin/env node

import { initDatabase } from './db.js';
import { ingestCorpus } from './ingest.js';

/**
 * Main CLI execution function for `npm run ingest`.
 * Connects to SQLite, executes the idempotent ingestion workflow,
 * and prints a clean summary of documents, chunks, exclusions, and errors.
 */
function main() {
  console.log('===============================================================');
  console.log('  Memory With a Receipt — Phase 1 Corpus Ingestion');
  console.log('===============================================================\n');

  const db = initDatabase('data/memory.db');

  try {
    const result = ingestCorpus(db, 'corpus/acme');

    console.log('--- INGESTION SUMMARY ---');
    console.log(`Indexed documents by category:`);
    console.log(`  • Email:       ${result.indexedByCategory.email || 0}`);
    console.log(`  • Report:      ${result.indexedByCategory.report || 0}`);
    console.log(`  • Transcript:  ${result.indexedByCategory.transcript || 0}`);
    console.log(`  ---------------------------`);
    console.log(`  Total Docs:    ${result.totalIndexedDocs}`);
    console.log(`  Total Chunks:  ${result.totalChunks}`);
    console.log(`  (New: ${result.newDocsCount}, Updated: ${result.updatedDocsCount}, Skipped/Unchanged: ${result.skippedDocsCount})\n`);

    console.log(`--- EXCLUDED FILES (${result.excludedFiles.length}) ---`);
    if (result.excludedFiles.length === 0) {
      console.log('  None');
    } else {
      for (const file of result.excludedFiles) {
        console.log(`  [Excluded] ${file}`);
      }
    }
    console.log();

    console.log(`--- FILE-LEVEL ERRORS ---`);
    if (result.errors.length === 0) {
      console.log('  None (0 errors)\n');
    } else {
      for (const err of result.errors) {
        console.error(`  [Error] ${err.file}: ${err.error}`);
      }
      console.log();
      process.exitCode = 1;
    }

    console.log('===============================================================');
    console.log('  Ingestion completed successfully.');
    console.log('===============================================================');
  } catch (error) {
    console.error('Fatal ingestion error:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
