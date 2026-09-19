import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase } from '../src/db.js';
import { previewPersonDeletion, computeDecisionBlastRadius } from '../src/deletion.js';
import { createDecisionEvent } from '../src/ledger.js';

function setupBlastRadiusTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blast-radius-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_a', 'emails/01_target_person.txt', '01_target_person.txt', 'email', '2024-01-01', 'h_a', 30)
  `).run();

  const chunkA1Text = 'Kwame Boateng: We must exclude the bakery module from Phase 1 and postpone shelf life mapping.';
  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_a_c0001', 'doc_a', 0, ?, 1, 15, 'emails/01_target_person.txt, lines 1-15', '2024-01-01')
  `).run(chunkA1Text);

  const chunkA2Text = 'Kwame Boateng: Postponing shelf life mapping was agreed in the morning sync.';
  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_a_c0002', 'doc_a', 1, ?, 10, 25, 'emails/01_target_person.txt, lines 10-25', '2024-01-01')
  `).run(chunkA2Text);

  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_b', 'emails/02_independent.txt', '02_independent.txt', 'email', '2024-01-01', 'h_b', 30)
  `).run();

  const chunkB1Text = 'Ana Duarte: Confirming bakery module is strictly out of scope until Q3.';
  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_b_c0001', 'doc_b', 0, ?, 1, 15, 'emails/02_independent.txt, lines 1-15', '2024-01-01')
  `).run(chunkB1Text);

  const chunkB2Text = 'Ana Duarte: In addition, bakery module timeline was communicated to all store leads.';
  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_b_c0002', 'doc_b', 1, ?, 10, 25, 'emails/02_independent.txt, lines 10-25', '2024-01-01')
  `).run(chunkB2Text);

  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_c', 'transcripts/03_kickoff.txt', '03_kickoff.txt', 'transcript', '2024-01-01', 'h_c', 30)
  `).run();

  const chunkC1Text = 'Carlos Mendes: The steering group re-confirmed bakery module exclusion.';
  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_c_c0001', 'doc_c', 0, ?, 1, 15, 'transcripts/03_kickoff.txt, lines 1-15', '2024-01-01')
  `).run(chunkC1Text);

  const evBakeryA = createDecisionEvent(db, {
    chunk_id: 'doc_a_c0001',
    event_type: 'proposal',
    topic: 'bakery scope',
    actor_name: 'Kwame Boateng',
    exact_quote: 'We must exclude the bakery module from Phase 1',
    confidence: 0.95,
    verification_status: 'candidate',
  });

  const evBakeryB1 = createDecisionEvent(db, {
    chunk_id: 'doc_b_c0001',
    event_type: 'status_claim',
    topic: 'bakery scope',
    actor_name: 'Ana Duarte',
    exact_quote: 'Confirming bakery module is strictly out of scope',
    confidence: 0.9,
    verification_status: 'candidate',
  });

  const evBakeryB2 = createDecisionEvent(db, {
    chunk_id: 'doc_b_c0002',
    event_type: 'status_claim',
    topic: 'bakery scope',
    actor_name: 'Ana Duarte',
    exact_quote: 'bakery module timeline was communicated',
    confidence: 0.85,
    verification_status: 'candidate',
  });

  const evBakeryC = createDecisionEvent(db, {
    chunk_id: 'doc_c_c0001',
    event_type: 'commitment',
    topic: 'bakery scope',
    actor_name: 'Carlos Mendes',
    exact_quote: 'The steering group re-confirmed bakery module exclusion.',
    confidence: 0.95,
    verification_status: 'candidate',
  });

  const evShelfA1 = createDecisionEvent(db, {
    chunk_id: 'doc_a_c0001',
    event_type: 'proposal',
    topic: 'shelf life mapping',
    actor_name: 'Kwame Boateng',
    exact_quote: 'postpone shelf life mapping.',
    confidence: 0.9,
    verification_status: 'candidate',
  });

  const evShelfA2 = createDecisionEvent(db, {
    chunk_id: 'doc_a_c0002',
    event_type: 'commitment',
    topic: 'shelf life mapping',
    actor_name: 'Kwame Boateng',
    exact_quote: 'Postponing shelf life mapping was agreed',
    confidence: 0.92,
    verification_status: 'candidate',
  });

  const evCommA = createDecisionEvent(db, {
    chunk_id: 'doc_a_c0002',
    event_type: 'action',
    topic: 'store lead communication',
    actor_name: 'Kwame Boateng',
    exact_quote: 'agreed in the morning sync',
    confidence: 0.8,
    verification_status: 'candidate',
  });

  const evCommB = createDecisionEvent(db, {
    chunk_id: 'doc_b_c0002',
    event_type: 'status_claim',
    topic: 'store lead communication',
    actor_name: 'Ana Duarte',
    exact_quote: 'timeline was communicated to all store leads',
    confidence: 0.88,
    verification_status: 'candidate',
  });

  return {
    db,
    tmpDir,
    evBakeryA,
    evBakeryB1,
    evBakeryB2,
    evBakeryC,
    evShelfA1,
    evShelfA2,
    evCommA,
    evCommB,
  };
}

function cleanupBlastRadiusTestDb(db, tmpDir) {
  try {
    db.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

test('1. previewPersonDeletion is 100% read-only and leaves database rows untouched', () => {
  const { db, tmpDir } = setupBlastRadiusTestDb();

  try {
    const chunkCountBefore = db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
    const eventCountBefore = db.prepare('SELECT COUNT(*) as count FROM decision_events').get().count;
    const docCountBefore = db.prepare('SELECT COUNT(*) as count FROM documents').get().count;

    const preview = previewPersonDeletion(db, 'Kwame Boateng');

    assert.equal(preview.targetName, 'Kwame Boateng');
    assert.equal(preview.affectedChunksCount, 2);
    assert.equal(preview.affectedEventsCount, 4);
    assert.ok(preview.blastRadius);

    const chunkCountAfter = db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
    const eventCountAfter = db.prepare('SELECT COUNT(*) as count FROM decision_events').get().count;
    const docCountAfter = db.prepare('SELECT COUNT(*) as count FROM documents').get().count;

    assert.equal(chunkCountAfter, chunkCountBefore);
    assert.equal(eventCountAfter, eventCountBefore);
    assert.equal(docCountAfter, docCountBefore);
  } finally {
    cleanupBlastRadiusTestDb(db, tmpDir);
  }
});

test('2. overlapping chunks from the same source document are not falsely counted as independent evidence', () => {
  const { db, tmpDir } = setupBlastRadiusTestDb();

  try {
    const preview = previewPersonDeletion(db, 'Kwame Boateng');
    const blastRadius = preview.blastRadius;

    const commTopic = blastRadius.topics.find((t) => t.topic === 'store lead communication');
    assert.ok(commTopic);
    assert.equal(commTopic.receiptsRemoved, 1);

    assert.equal(commTopic.independentReceiptsRemaining, 1);
    assert.equal(commTopic.classification, 'reduced_evidence');
  } finally {
    cleanupBlastRadiusTestDb(db, tmpDir);
  }
});

test('3. a topic with surviving evidence across >= 2 independent source documents is classified as still_supported', () => {
  const { db, tmpDir } = setupBlastRadiusTestDb();

  try {
    const preview = previewPersonDeletion(db, 'Kwame Boateng');
    const blastRadius = preview.blastRadius;

    const bakeryTopic = blastRadius.topics.find((t) => t.topic === 'bakery scope');
    assert.ok(bakeryTopic);
    assert.equal(bakeryTopic.receiptsRemoved, 1);

    assert.equal(bakeryTopic.independentReceiptsRemaining, 2);
    assert.equal(bakeryTopic.classification, 'still_supported');
    assert.equal(bakeryTopic.survivingReceipts.length, 2);
  } finally {
    cleanupBlastRadiusTestDb(db, tmpDir);
  }
});

test('4. a topic with zero surviving derived evidence is classified as no_derived_evidence_remaining', () => {
  const { db, tmpDir } = setupBlastRadiusTestDb();

  try {
    const preview = previewPersonDeletion(db, 'Kwame Boateng');
    const blastRadius = preview.blastRadius;

    const shelfTopic = blastRadius.topics.find((t) => t.topic === 'shelf life mapping');
    assert.ok(shelfTopic);
    assert.equal(shelfTopic.receiptsRemoved, 2);
    assert.equal(shelfTopic.independentReceiptsRemaining, 0);
    assert.equal(shelfTopic.classification, 'no_derived_evidence_remaining');
    assert.equal(shelfTopic.survivingReceipts.length, 0);
    assert.equal(shelfTopic.removedReceipts.length, 2);
  } finally {
    cleanupBlastRadiusTestDb(db, tmpDir);
  }
});

test('5. blast radius prioritizes highest risk topics first and summarizes counts accurately', () => {
  const { db, tmpDir } = setupBlastRadiusTestDb();

  try {
    const preview = previewPersonDeletion(db, 'Kwame Boateng');
    const blastRadius = preview.blastRadius;

    assert.equal(blastRadius.summary.totalAffectedTopics, 3);
    assert.equal(blastRadius.summary.noDerivedEvidenceRemaining, 1);
    assert.equal(blastRadius.summary.reducedEvidence, 1);
    assert.equal(blastRadius.summary.stillSupported, 1);

    assert.equal(blastRadius.topics[0].topic, 'shelf life mapping');
    assert.equal(blastRadius.topics[0].classification, 'no_derived_evidence_remaining');

    assert.equal(blastRadius.topics[1].topic, 'store lead communication');
    assert.equal(blastRadius.topics[1].classification, 'reduced_evidence');

    assert.equal(blastRadius.topics[2].topic, 'bakery scope');
    assert.equal(blastRadius.topics[2].classification, 'still_supported');
  } finally {
    cleanupBlastRadiusTestDb(db, tmpDir);
  }
});

test('6. preview response never claims raw corpus or source-system records are deleted', () => {
  const { db, tmpDir } = setupBlastRadiusTestDb();

  try {
    const preview = previewPersonDeletion(db, 'Kwame Boateng');
    const jsonStr = JSON.stringify(preview);

    assert.ok(!jsonStr.includes('deleted from source system'));
    assert.ok(!jsonStr.includes('corpus files deleted'));
    assert.ok(!jsonStr.includes('invalid decision'));
  } finally {
    cleanupBlastRadiusTestDb(db, tmpDir);
  }
});
