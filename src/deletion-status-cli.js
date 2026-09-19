#!/usr/bin/env node
import { initDatabase } from './db.js';
import { getDeletionTombstones, verifyPersonDeletion } from './deletion.js';

async function main() {
  const dbPath = process.env.DB_PATH || 'data/memory.db';
  const db = initDatabase(dbPath);

  console.log('\n================================================================');
  console.log('        MEMORY WITH A RECEIPT: DELETION TOMBSTONES STATUS');
  console.log('================================================================');
  console.log(`Database:  ${dbPath}`);
  console.log('----------------------------------------------------------------\n');

  try {
    const tombstones = getDeletionTombstones(db);

    if (tombstones.length === 0) {
      console.log('ℹ️  No deletion tombstones registered in the system.');
      console.log('   All ingested persons and chunks remain active.\n');
      console.log('================================================================\n');
      return;
    }

    console.log(`Found ${tombstones.length} registered deletion tombstone(s):\n`);

    tombstones.forEach((t, i) => {
      let details = {};
      try {
        if (t.details_json) details = JSON.parse(t.details_json);
      } catch {}

      const ver = verifyPersonDeletion(db, t.target_value);

      console.log(`${i + 1}. [${t.target_type.toUpperCase()}] "${t.target_value}" (normalized: "${t.normalized_value}")`);
      console.log(`   • Requested:   ${t.requested_at}`);
      console.log(`   • Completed:   ${t.completed_at || 'In progress'}`);
      if (details.chunksDeleted !== undefined) {
        console.log(`   • Purged Data: ${details.chunksDeleted} chunks, ${details.totalEventsDeleted || 0} events, ${details.embeddingsDeleted || 0} embeddings`);
      }
      console.log(`   • Live Audit:  ${ver.verified ? '✅ ZERO TRACE IN ALL STORES' : '⚠️ UNPURGED DATA DETECTED'}`);
      console.log(`     - Remaining Chunks: ${ver.remainingChunks}, FTS: ${ver.remainingFtsResults}, Events: ${ver.remainingEvents}, Embeddings: ${ver.remainingEmbeddings}`);
      console.log('');
    });

    console.log('================================================================\n');
  } catch (err) {
    console.error(`\n❌ Error fetching deletion status: ${err.message}\n`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
