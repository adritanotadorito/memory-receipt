#!/usr/bin/env node
import { initDatabase } from './db.js';
import { previewPersonDeletion, deletePersonData, verifyPersonDeletion } from './deletion.js';

async function main() {
  const args = process.argv.slice(2);
  const isConfirm = args.includes('--confirm');
  const isDryRun = args.includes('--dry-run') || !isConfirm;

  const nonFlagArgs = args.filter((arg) => !arg.startsWith('--'));
  const personName = nonFlagArgs.join(' ').trim();

  if (!personName) {
    console.error('\n❌ Please provide the name of the person to delete.');
    console.error('Usage:');
    console.error('  npm run delete-person -- "<Person Name>" --dry-run');
    console.error('  npm run delete-person -- "<Person Name>" --confirm\n');
    process.exit(1);
  }

  const dbPath = process.env.DB_PATH || 'data/memory.db';
  const db = initDatabase(dbPath);

  console.log('\n================================================================');
  console.log('          MEMORY WITH A RECEIPT: PERSON DELETION SERVICE');
  console.log('================================================================');
  console.log(`Target Person:  "${personName}"`);
  console.log(`Database:       ${dbPath}`);
  console.log(`Mode:           ${isConfirm ? '🔴 CONFIRMED DELETION' : '🟡 DRY RUN (PREVIEW ONLY)'}`);
  console.log('----------------------------------------------------------------\n');

  try {
    const preview = previewPersonDeletion(db, personName);

    if (preview.affectedChunksCount === 0 && preview.affectedEventsCount === 0) {
      console.log(`ℹ️  No data found in the system for person "${personName}".`);
      console.log('   Zero chunks and zero decision events match this name.\n');
      console.log('================================================================\n');
      return;
    }

    console.log('--- Impact Analysis ---');
    console.log(`  • Chunks to delete:        ${preview.affectedChunksCount}`);
    console.log(`  • FTS index rows to purge: ${preview.affectedChunksCount}`);
    console.log(`  • Decision ledger events:  ${preview.affectedEventsCount}`);
    console.log(`  • Decision graph relations: ${preview.affectedRelationsCount}`);
    console.log(`  • Vector embeddings:       ${preview.affectedEmbeddingsCount}`);
    console.log(`  • Extraction records:      ${preview.affectedExtractionsCount}`);
    console.log(`  • Affected Documents:      ${preview.affectedDocuments.length}`);
    preview.affectedDocuments.forEach((doc) => {
      console.log(`      - ${doc}`);
    });
    console.log('');

    if (isDryRun) {
      console.log('----------------------------------------------------------------');
      console.log('⚠️  DRY RUN MODE: No data was modified or deleted.');
      console.log('To permanently delete this person from all derived stores, rerun with:');
      console.log(`  npm run delete-person -- "${personName}" --confirm\n`);
      console.log('================================================================\n');
      return;
    }

    console.log('--- Executing Deletion ---');
    const result = deletePersonData(db, personName);

    console.log(`  ✅ Deleted ${result.deletedChunksCount} chunks from chunks table`);
    console.log(`  ✅ Purged ${result.deletedChunksCount} FTS5 full-text index rows`);
    console.log(`  ✅ Purged ${result.deletedEmbeddingsCount} vector embeddings`);
    console.log(`  ✅ Purged ${result.deletedExtractionsCount} extraction records`);
    console.log(`  ✅ Purged ${result.deletedEventsCount} decision ledger events`);
    console.log(`  ✅ Purged ${result.deletedRelationsCount} decision relations`);
    console.log('  ✅ Created immutable audit trail: DELETE_PERSON_DATA');
    console.log('  ✅ Stored durable deletion tombstone (immunizes future ingestion)');
    console.log('');

    console.log('--- Post-Deletion Verification ---');
    const ver = result.verification;
    console.log(`  • Remaining Chunks:        ${ver.remainingChunks} ${ver.remainingChunks === 0 ? '✅ (Zero trace)' : '❌'}`);
    console.log(`  • Remaining FTS Matches:   ${ver.remainingFtsResults} ${ver.remainingFtsResults === 0 ? '✅ (Zero trace)' : '❌'}`);
    console.log(`  • Remaining Ledger Events: ${ver.remainingEvents} ${ver.remainingEvents === 0 ? '✅ (Zero trace)' : '❌'}`);
    console.log(`  • Remaining Embeddings:    ${ver.remainingEmbeddings} ${ver.remainingEmbeddings === 0 ? '✅ (Zero trace)' : '❌'}`);
    console.log(`  • Project Cache:           ${ver.cache}`);
    console.log(`  • Overall Status:          ${ver.verified ? '✅ 100% PURGED & AUDITABLE' : '❌ VERIFICATION FAILED'}`);
    console.log('');

    console.log('================================================================\n');
  } catch (err) {
    console.error(`\n❌ Error processing person deletion: ${err.message}\n`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
