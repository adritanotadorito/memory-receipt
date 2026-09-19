#!/usr/bin/env node
import { initDatabase } from './db.js';
import { extractAllChunks } from './extract-events.js';

async function main() {
  const args = process.argv.slice(2);
  let limit = null;
  let force = false;
  let resume = true;
  let concurrency = 2;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit' || arg === '-l') {
      limit = parseInt(args[++i], 10);
    } else if (arg === '--force' || arg === '-f') {
      force = true;
      resume = false;
    } else if (arg === '--resume') {
      resume = true;
      force = false;
    } else if (arg === '--no-resume') {
      resume = false;
    } else if (arg === '--concurrency' || arg === '-c') {
      concurrency = parseInt(args[++i], 10);
    }
  }

  const dbPath = process.env.DB_PATH || 'data/memory.db';
  const db = initDatabase(dbPath);

  console.log('\n========================================');
  console.log('    DECISION EVENT EXTRACTION PIPELINE');
  console.log('========================================');
  console.log(`Database:     ${dbPath}`);
  console.log(`Model:        ${process.env.OPENAI_MODEL || 'gpt-4.1-mini'}`);
  console.log(`Limit:        ${limit ? limit : 'All eligible chunks'}`);
  console.log(`Mode:         ${force ? 'FORCE (reprocessing all)' : resume ? 'RESUME (skipping previously processed)' : 'STANDARD'}`);
  console.log(`Concurrency:  ${concurrency}`);
  console.log('----------------------------------------\n');

  try {
    const summary = await extractAllChunks(db, {
      limit,
      resume,
      force,
      concurrency,
      onProgress: (prog) => {
        const pct = prog.total > 0 ? Math.round((prog.processed / prog.total) * 100) : 100;
        const details = [];
        if (prog.insertedCount > 0) details.push(`${prog.insertedCount} inserted`);
        if (prog.duplicatesCount > 0) details.push(`${prog.duplicatesCount} dupes`);
        if (prog.rejectedQuotesCount > 0) details.push(`${prog.rejectedQuotesCount} bad quotes`);
        if (prog.missingTopicCount > 0) details.push(`${prog.missingTopicCount} no topic`);
        if (prog.invalidSchemaCount > 0) details.push(`${prog.invalidSchemaCount} bad schema`);

        const detailStr = details.length > 0 ? `(${details.join(', ')})` : '(0 events)';
        const msg = `[${prog.processed}/${prog.total} (${pct}%)] Chunk ${prog.chunkId}: ${detailStr}`;
        if (prog.error) {
          console.warn(`⚠️  ${msg} [ERROR: ${prog.error}]`);
        } else {
          console.log(`⚡ ${msg}`);
        }
      },
    });

    console.log('\n========================================');
    console.log('          EXTRACTION COMPLETE');
    console.log('========================================');
    console.log(`Total Chunks Scanned:       ${summary.totalChunks}`);
    console.log(`Chunks Processed:           ${summary.processedChunks}`);
    console.log(`Chunks Skipped:             ${summary.skippedChunks}`);
    console.log(`Candidate Events Inserted:  ${summary.candidateEventsInserted}`);
    console.log(`Duplicates Skipped:         ${summary.duplicatesSkipped}`);
    console.log(`Invalid Quotes Rejected:    ${summary.invalidQuotesRejected}`);
    console.log(`Missing Topics Rejected:    ${summary.missingTopicsRejected}`);
    console.log(`Invalid Schema Rejected:    ${summary.invalidSchemaRejected}`);
    console.log(`Errors Encountered:         ${summary.errors.length}`);
    console.log(`Elapsed Time:               ${(summary.elapsedMs / 1000).toFixed(2)}s`);
    console.log('========================================\n');
  } catch (err) {
    console.error(`\n❌ Pipeline crashed: ${err.message}\n`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
