import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase } from '../src/db.js';
import { ingestCorpus } from '../src/ingest.js';
import {
  previewPersonDeletion,
  deletePersonData,
  verifyPersonDeletion,
  getDeletionTombstones,
  normalizePersonName,
} from '../src/deletion.js';
import { createDecisionEvent, createEventRelation } from '../src/ledger.js';

function setupDeletionTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deletion-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  const corpusDir = path.join(tmpDir, 'corpus', 'acme');
  const emailsDir = path.join(corpusDir, 'emails');
  fs.mkdirSync(emailsDir, { recursive: true });

  // Document 1 with Kwame Boateng
  const doc1Content = [
    'Subject: Shelf-Life Field Mapping Discussion',
    'From: Kwame Boateng <kwame@acme.org>',
    'Date: 2024-03-15',
    '',
    'We are proposing to map shelf_life_days to the expiration_window field in ERP.',
    'Sofia agreed that this avoids duplicate date calculations during the warehouse migration.',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(emailsDir, '01_shelf.txt'), doc1Content);

  // Document 2 without Kwame Boateng
  const doc2Content = [
    'Subject: Warehouse Dairy Operations',
    'From: Ana Duarte <ana@acme.org>',
    'Date: 2024-03-16',
    '',
    'Dairy and chilled ready meals replenishment schedules are confirmed for regional stores.',
    'No bakery items will be processed in this distribution center.',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(emailsDir, '02_dairy.txt'), doc2Content);

  // Ingest initial documents
  ingestCorpus(db, corpusDir);

  const chunk1 = db.prepare("SELECT * FROM chunks WHERE INSTR(chunk_text, 'Kwame Boateng') > 0").get();
  const chunk2 = db.prepare("SELECT * FROM chunks WHERE INSTR(chunk_text, 'Ana Duarte') > 0").get();

  assert.ok(chunk1, 'Chunk 1 must exist');
  assert.ok(chunk2, 'Chunk 2 must exist');

  // Seed mock embeddings
  db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, model_name, embedding_json, created_at)
    VALUES (?, 'test-model', '[0.1, 0.2]', '2024-01-01')
  `).run(chunk1.id);
  db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, model_name, embedding_json, created_at)
    VALUES (?, 'test-model', '[0.3, 0.4]', '2024-01-01')
  `).run(chunk2.id);

  // Seed mock extractions
  db.prepare(`
    INSERT INTO chunk_extractions (chunk_id, extractor_version, model_name, completed_at, event_count)
    VALUES (?, 'v1', 'gpt-4', '2024-01-01', 2)
  `).run(chunk1.id);
  db.prepare(`
    INSERT INTO chunk_extractions (chunk_id, extractor_version, model_name, completed_at, event_count)
    VALUES (?, 'v1', 'gpt-4', '2024-01-01', 1)
  `).run(chunk2.id);

  // Seed decision events
  const ev1 = createDecisionEvent(db, {
    chunk_id: chunk1.id,
    event_type: 'proposal',
    topic: 'shelf life mapping',
    value: 'expiration_window',
    actor_name: 'Kwame Boateng',
    event_date: '2024-03-15',
    exact_quote: 'We are proposing to map shelf_life_days to the expiration_window field in ERP.',
    confidence: 0.95,
    verification_status: 'candidate',
  });

  const ev2 = createDecisionEvent(db, {
    chunk_id: chunk1.id,
    event_type: 'commitment',
    topic: 'date calculation avoidance',
    actor_name: 'Sofia',
    event_date: '2024-03-15',
    exact_quote: 'Sofia agreed that this avoids duplicate date calculations during the warehouse migration.',
    confidence: 0.9,
    verification_status: 'candidate',
  });

  const ev3 = createDecisionEvent(db, {
    chunk_id: chunk2.id,
    event_type: 'commitment',
    topic: 'dairy replenishment schedule',
    actor_name: 'Ana Duarte',
    event_date: '2024-03-16',
    exact_quote: 'Dairy and chilled ready meals replenishment schedules are confirmed for regional stores.',
    confidence: 0.98,
    verification_status: 'candidate',
  });

  // Seed event relations
  createEventRelation(db, {
    from_event_id: ev1.id,
    to_event_id: ev2.id,
    relation_type: 'supports',
    explanation: 'Kwame proposal supported by Sofia',
  });

  createEventRelation(db, {
    from_event_id: ev2.id,
    to_event_id: ev3.id,
    relation_type: 'follows_up_on',
    explanation: 'Cross-topic coordination',
  });

  return {
    db,
    tmpDir,
    corpusDir,
    chunk1Id: chunk1.id,
    chunk2Id: chunk2.id,
    ev1Id: ev1.id,
    ev2Id: ev2.id,
    ev3Id: ev3.id,
  };
}

function cleanupDeletionTestDb(db, tmpDir) {
  try {
    db.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

test('1. normalizePersonName trims whitespace and lowercases input', () => {
  assert.equal(normalizePersonName('  Kwame Boateng  '), 'kwame boateng');
  assert.equal(normalizePersonName('SOFIA ALMEIDA'), 'sofia almeida');
  assert.equal(normalizePersonName(''), '');
  assert.equal(normalizePersonName(null), '');
});

test('2. previewPersonDeletion returns accurate impact counts without modifying any data', () => {
  const { db, tmpDir, chunk1Id, ev1Id, ev2Id } = setupDeletionTestDb();

  try {
    const preview = previewPersonDeletion(db, 'Kwame Boateng');

    assert.equal(preview.targetName, 'Kwame Boateng');
    assert.equal(preview.normalizedName, 'kwame boateng');
    assert.equal(preview.affectedChunksCount, 1);
    assert.equal(preview.affectedChunks[0].chunk_id, chunk1Id);
    assert.equal(preview.affectedEventsCount, 2); // ev1 (actor Kwame) + ev2 (same chunk)
    assert.equal(preview.affectedRelationsCount, 2); // rel 1 & rel 2
    assert.equal(preview.affectedEmbeddingsCount, 1);
    assert.equal(preview.affectedExtractionsCount, 1);
    assert.equal(preview.affectedDocuments.length, 1);
    assert.ok(preview.affectedDocuments[0].endsWith('emails/01_shelf.txt'));

    // Verify nothing was deleted
    const chunkCount = db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
    assert.equal(chunkCount, 2);
    const eventCount = db.prepare('SELECT COUNT(*) as count FROM decision_events').get().count;
    assert.equal(eventCount, 3);
  } finally {
    cleanupDeletionTestDb(db, tmpDir);
  }
});

test('3. confirmed deletion removes target chunks, FTS entries, embeddings, events, relations, and extraction records', () => {
  const { db, tmpDir, chunk1Id, chunk2Id, ev1Id, ev2Id, ev3Id } = setupDeletionTestDb();

  try {
    const result = deletePersonData(db, 'Kwame Boateng');

    assert.equal(result.success, true);
    assert.equal(result.deletedChunksCount, 1);
    assert.equal(result.deletedEventsCount, 2);
    assert.equal(result.deletedRelationsCount, 2);
    assert.equal(result.deletedEmbeddingsCount, 1);
    assert.equal(result.deletedExtractionsCount, 1);

    // 1. Chunks table check
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM chunks WHERE id = ?').get(chunk1Id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM chunks WHERE id = ?').get(chunk2Id).count, 1);

    // 2. FTS5 index check
    const ftsMatches = db.prepare("SELECT COUNT(*) as count FROM chunks_fts WHERE chunks_fts MATCH '\"Kwame\"'").get().count;
    assert.equal(ftsMatches, 0);

    // 3. Vector embeddings check
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM chunk_embeddings WHERE chunk_id = ?').get(chunk1Id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM chunk_embeddings WHERE chunk_id = ?').get(chunk2Id).count, 1);

    // 4. Extraction records check
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM chunk_extractions WHERE chunk_id = ?').get(chunk1Id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM chunk_extractions WHERE chunk_id = ?').get(chunk2Id).count, 1);

    // 5. Decision events check
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM decision_events WHERE id = ?').get(ev1Id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM decision_events WHERE id = ?').get(ev2Id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM decision_events WHERE id = ?').get(ev3Id).count, 1);

    // 6. Event relations check
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM event_relations').get().count, 0);

    // 7. Tombstone check
    const tombstones = getDeletionTombstones(db);
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0].target_value, 'Kwame Boateng');
    assert.equal(tombstones[0].normalized_value, 'kwame boateng');
    assert.ok(tombstones[0].completed_at);
  } finally {
    cleanupDeletionTestDb(db, tmpDir);
  }
});

test('4. audit log entry exists with DELETE_PERSON_DATA and detailed breakdown', () => {
  const { db, tmpDir } = setupDeletionTestDb();

  try {
    deletePersonData(db, 'Kwame Boateng');

    const auditEntry = db.prepare("SELECT * FROM audit_log WHERE action = 'DELETE_PERSON_DATA'").get();
    assert.ok(auditEntry, 'Audit log must contain DELETE_PERSON_DATA action');
    assert.ok(auditEntry.timestamp);

    const details = JSON.parse(auditEntry.details);
    assert.equal(details.targetName, 'Kwame Boateng');
    assert.equal(details.normalizedName, 'kwame boateng');
    assert.equal(details.chunksDeleted, 1);
    assert.equal(details.totalEventsDeleted, 2);
  } finally {
    cleanupDeletionTestDb(db, tmpDir);
  }
});

test('5. rerunning ingestion does not resurrect deleted person data from raw corpus', () => {
  const { db, tmpDir, corpusDir, chunk1Id } = setupDeletionTestDb();

  try {
    // 1. Delete Kwame Boateng
    deletePersonData(db, 'Kwame Boateng');
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM chunks WHERE id = ?').get(chunk1Id).count, 0);

    // 2. Rerun ingestion from the raw corpus (which still has 01_shelf.txt on disk)
    const ingestSummary = ingestCorpus(db, corpusDir);
    assert.ok(ingestSummary);

    // 3. Verify chunk containing Kwame was NOT reinserted
    const resurrectedChunks = db.prepare("SELECT COUNT(*) as count FROM chunks WHERE INSTR(LOWER(chunk_text), 'kwame boateng') > 0").get().count;
    assert.equal(resurrectedChunks, 0, 'Deleted person chunks must NEVER be resurrected on re-ingestion');

    // 4. Verify un-deleted chunk is still present
    const dairyChunks = db.prepare("SELECT COUNT(*) as count FROM chunks WHERE INSTR(chunk_text, 'Ana Duarte') > 0").get().count;
    assert.equal(dairyChunks, 1);
  } finally {
    cleanupDeletionTestDb(db, tmpDir);
  }
});

test('6. deleting a non-existent person is safe, idempotent, and creates a valid tombstone', () => {
  const { db, tmpDir } = setupDeletionTestDb();

  try {
    const result = deletePersonData(db, 'Person That Never Existed');
    assert.equal(result.success, true);
    assert.equal(result.deletedChunksCount, 0);
    assert.equal(result.deletedEventsCount, 0);

    const ver = verifyPersonDeletion(db, 'Person That Never Existed');
    assert.equal(ver.verified, true);
    assert.equal(ver.remainingChunks, 0);
    assert.equal(ver.remainingEvents, 0);
  } finally {
    cleanupDeletionTestDb(db, tmpDir);
  }
});

test('7. verifyPersonDeletion returns verified: true and explicitly reports cache: none', () => {
  const { db, tmpDir } = setupDeletionTestDb();

  try {
    deletePersonData(db, 'Kwame Boateng');

    const ver = verifyPersonDeletion(db, 'Kwame Boateng');
    assert.equal(ver.verified, true);
    assert.equal(ver.remainingChunks, 0);
    assert.equal(ver.remainingFtsResults, 0);
    assert.equal(ver.remainingEvents, 0);
    assert.equal(ver.remainingEmbeddings, 0);
    assert.equal(ver.remainingExtractions, 0);
    assert.equal(ver.cache, 'none (no project cache stores exist)');
  } finally {
    cleanupDeletionTestDb(db, tmpDir);
  }
});
