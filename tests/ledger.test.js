import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { initDatabase } from '../src/db.js';
import {
  createDecisionEvent,
  createEventRelation,
  getEventsForTopic,
  getLocalEventGraph,
  deleteDecisionEvent,
  VALID_EVENT_TYPES,
  VALID_VERIFICATION_STATUSES,
  VALID_RELATION_TYPES,
} from '../src/ledger.js';

function setupTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  const docId = 'doc_test_01';
  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    docId,
    'emails/01_shelf_life.txt',
    '01_shelf_life.txt',
    'email',
    '2024-03-20T10:00:00.000Z',
    'hash123',
    50
  );

  const chunk1Id = 'doc_test_01_c0001';
  const chunk1Text = `Subject: Shelf-Life Field Mapping Discussion
From: Kwame Boateng <kwame@acme.org>
Date: 2024-03-15

We are proposing to map shelf_life_days to the expiration_window field in ERP.
Sofia agreed that this avoids duplicate date calculations during the warehouse migration.`;

  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunk1Id,
    docId,
    0,
    chunk1Text,
    1,
    10,
    'emails/01_shelf_life.txt, lines 1-10',
    '2024-03-20T10:00:00.000Z'
  );

  const chunk2Id = 'doc_test_01_c0002';
  const chunk2Text = `Subject: Re: Shelf-Life Field Mapping Discussion
From: Sofia Almeida <sofia@acme.org>
Date: 2024-03-18

Due to regulatory audit requirements, we must reverse the previous proposal.
The expiration_window field cannot store raw integers, so shelf_life_days will remain in WMS.`;

  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunk2Id,
    docId,
    1,
    chunk2Text,
    11,
    20,
    'emails/01_shelf_life.txt, lines 11-20',
    '2024-03-20T10:00:00.000Z'
  );

  return { db, tmpDir, chunk1Id, chunk2Id, docId };
}

function cleanupTestDb(db, tmpDir) {
  try {
    db.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

test('1. valid quoted event creation succeeds with audit logging', () => {
  const { db, tmpDir, chunk1Id } = setupTestDb();

  try {
    const quote = 'We are proposing to map shelf_life_days to the expiration_window field in ERP.';
    const event = createDecisionEvent(db, {
      chunk_id: chunk1Id,
      event_type: 'proposal',
      topic: 'Shelf Life Field Mapping',
      value: 'shelf_life_days -> expiration_window',
      actor_name: 'Kwame Boateng',
      actor_organization: 'Acme Logistics',
      event_date: '2024-03-15',
      exact_quote: quote,
      confidence: 0.95,
      verification_status: 'candidate',
    });

    assert.ok(typeof event.id === 'number' && event.id > 0);
    assert.equal(event.chunk_id, chunk1Id);
    assert.equal(event.event_type, 'proposal');
    assert.equal(event.topic, 'Shelf Life Field Mapping');
    assert.equal(event.exact_quote, quote);
    assert.equal(event.confidence, 0.95);
    assert.equal(event.verification_status, 'candidate');

    const saved = db.prepare('SELECT * FROM decision_events WHERE id = ?').get(event.id);
    assert.ok(saved);
    assert.equal(saved.exact_quote, quote);
    assert.equal(saved.actor_name, 'Kwame Boateng');

    const audit = db.prepare('SELECT * FROM audit_log WHERE action = ?').get('CREATE_DECISION_EVENT');
    assert.ok(audit);
    assert.equal(audit.document_id, 'doc_test_01');
    assert.equal(audit.relative_path, 'emails/01_shelf_life.txt');
    const details = JSON.parse(audit.details);
    assert.equal(details.event_id, event.id);
    assert.equal(details.topic, 'Shelf Life Field Mapping');
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('2. invented quote is rejected immediately', () => {
  const { db, tmpDir, chunk1Id } = setupTestDb();

  try {
    assert.throws(
      () => {
        createDecisionEvent(db, {
          chunk_id: chunk1Id,
          event_type: 'commitment',
          topic: 'Shelf Life Field Mapping',
          exact_quote: 'We decided to completely delete the warehouse database yesterday.',
          confidence: 0.8,
          verification_status: 'candidate',
        });
      },
      {
        message: /Grounding validation failed: exact_quote is not literally contained/,
      }
    );

    const count = db.prepare('SELECT COUNT(*) as count FROM decision_events').get();
    assert.equal(count.count, 0);
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('3. invalid types, status, confidence, and missing fields are rejected', () => {
  const { db, tmpDir, chunk1Id } = setupTestDb();

  try {
    const validQuote = 'We are proposing to map shelf_life_days to the expiration_window field in ERP.';

    assert.throws(
      () => {
        createDecisionEvent(db, {
          chunk_id: chunk1Id,
          event_type: 'made_up_event_type',
          topic: 'Test Topic',
          exact_quote: validQuote,
          confidence: 0.9,
          verification_status: 'candidate',
        });
      },
      { message: /Invalid event_type/ }
    );

    assert.throws(
      () => {
        createDecisionEvent(db, {
          chunk_id: chunk1Id,
          event_type: 'proposal',
          topic: 'Test Topic',
          exact_quote: validQuote,
          confidence: 0.9,
          verification_status: 'invalid_status',
        });
      },
      { message: /Invalid verification_status/ }
    );

    assert.throws(
      () => {
        createDecisionEvent(db, {
          chunk_id: chunk1Id,
          event_type: 'proposal',
          topic: 'Test Topic',
          exact_quote: validQuote,
          confidence: 1.5,
          verification_status: 'candidate',
        });
      },
      { message: /confidence must be a number between 0.0 and 1.0/ }
    );

    assert.throws(
      () => {
        createDecisionEvent(db, {
          chunk_id: chunk1Id,
          event_type: 'proposal',
          topic: 'Test Topic',
          exact_quote: validQuote,
          confidence: -0.2,
          verification_status: 'candidate',
        });
      },
      { message: /confidence must be a number between 0.0 and 1.0/ }
    );

    assert.throws(
      () => {
        createDecisionEvent(db, {
          chunk_id: 'non_existent_chunk_999',
          event_type: 'proposal',
          topic: 'Test Topic',
          exact_quote: validQuote,
          confidence: 0.9,
          verification_status: 'candidate',
        });
      },
      { message: /Referenced chunk_id .* does not exist/ }
    );

    assert.throws(
      () => {
        createDecisionEvent(db, {
          chunk_id: chunk1Id,
          event_type: 'proposal',
          topic: 'Test Topic',
          exact_quote: '',
          confidence: 0.9,
          verification_status: 'candidate',
        });
      },
      { message: /exact_quote must be a non-empty string/ }
    );

    assert.throws(
      () => {
        createDecisionEvent(db, {
          chunk_id: chunk1Id,
          event_type: 'proposal',
          topic: '   ',
          exact_quote: validQuote,
          confidence: 0.9,
          verification_status: 'candidate',
        });
      },
      { message: /topic must be a non-empty string/ }
    );
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('4. relations are returned in a topic’s local graph with endpoint validation', () => {
  const { db, tmpDir, chunk1Id, chunk2Id } = setupTestDb();

  try {

    const event1 = createDecisionEvent(db, {
      chunk_id: chunk1Id,
      event_type: 'proposal',
      topic: 'Shelf Life Field Mapping',
      actor_name: 'Kwame Boateng',
      event_date: '2024-03-15',
      exact_quote: 'We are proposing to map shelf_life_days to the expiration_window field in ERP.',
      confidence: 0.9,
      verification_status: 'superseded',
    });

    const event2 = createDecisionEvent(db, {
      chunk_id: chunk2Id,
      event_type: 'reversal',
      topic: 'Shelf Life Field Mapping',
      actor_name: 'Sofia Almeida',
      event_date: '2024-03-18',
      exact_quote: 'Due to regulatory audit requirements, we must reverse the previous proposal.',
      confidence: 0.95,
      verification_status: 'supported',
    });

    assert.throws(
      () => {
        createEventRelation(db, {
          from_event_id: event2.id,
          to_event_id: 99999,
          relation_type: 'supersedes',
          explanation: 'Reversal supersedes proposal',
        });
      },
      { message: /Target decision event with id 99999 does not exist/ }
    );

    assert.throws(
      () => {
        createEventRelation(db, {
          from_event_id: event2.id,
          to_event_id: event1.id,
          relation_type: 'not_a_valid_relation',
          explanation: 'Invalid type',
        });
      },
      { message: /Invalid relation_type/ }
    );

    const relation = createEventRelation(db, {
      from_event_id: event2.id,
      to_event_id: event1.id,
      relation_type: 'supersedes',
      explanation: 'Sofia reversed the ERP field mapping proposal due to audit requirements.',
    });

    assert.ok(typeof relation.id === 'number');
    assert.equal(relation.from_event_id, event2.id);
    assert.equal(relation.to_event_id, event1.id);
    assert.equal(relation.relation_type, 'supersedes');

    const graph = getLocalEventGraph(db, 'Shelf Life Field Mapping');
    assert.equal(graph.topic, 'Shelf Life Field Mapping');
    assert.equal(graph.events.length, 2);
    assert.equal(graph.relations.length, 1);

    assert.equal(graph.events[0].id, event1.id);
    assert.equal(graph.events[1].id, event2.id);
    assert.equal(graph.relations[0].id, relation.id);
    assert.equal(graph.relations[0].relation_type, 'supersedes');
    assert.equal(graph.relations[0].from_topic, 'Shelf Life Field Mapping');
    assert.equal(graph.relations[0].to_topic, 'Shelf Life Field Mapping');

    const events = getEventsForTopic(db, 'Shelf Life Field Mapping');
    assert.equal(events.length, 2);
    assert.equal(events[0].source_location, 'emails/01_shelf_life.txt, lines 1-10');
    assert.equal(events[1].source_location, 'emails/01_shelf_life.txt, lines 11-20');
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('5. deleting a chunk truly cascades to events and relations', () => {
  const { db, tmpDir, chunk1Id, chunk2Id } = setupTestDb();

  try {
    const event1 = createDecisionEvent(db, {
      chunk_id: chunk1Id,
      event_type: 'proposal',
      topic: 'Cascade Test',
      exact_quote: 'We are proposing to map shelf_life_days to the expiration_window field in ERP.',
      confidence: 0.9,
      verification_status: 'candidate',
    });

    const event2 = createDecisionEvent(db, {
      chunk_id: chunk2Id,
      event_type: 'action',
      topic: 'Cascade Test',
      exact_quote: 'The expiration_window field cannot store raw integers, so shelf_life_days will remain in WMS.',
      confidence: 0.9,
      verification_status: 'candidate',
    });

    const relation = createEventRelation(db, {
      from_event_id: event2.id,
      to_event_id: event1.id,
      relation_type: 'follows_up_on',
      explanation: 'Follow up action',
    });

    assert.equal(db.prepare('SELECT COUNT(*) as c FROM decision_events').get().c, 2);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM event_relations').get().c, 1);

    db.prepare('DELETE FROM chunks WHERE id = ?').run(chunk1Id);

    const remainingEvents = db.prepare('SELECT * FROM decision_events').all();
    assert.equal(remainingEvents.length, 1);
    assert.equal(remainingEvents[0].id, event2.id);

    const remainingRelations = db.prepare('SELECT COUNT(*) as c FROM event_relations').get();
    assert.equal(remainingRelations.c, 0);

    const deleteResult = deleteDecisionEvent(db, event2.id);
    assert.equal(deleteResult.deleted, true);
    assert.equal(deleteResult.changes, 1);

    assert.equal(db.prepare('SELECT COUNT(*) as c FROM decision_events').get().c, 0);

    const delAudit = db.prepare('SELECT * FROM audit_log WHERE action = ?').get('DELETE_DECISION_EVENT');
    assert.ok(delAudit);
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('6. schema declares decision_events.chunk_id as INTEGER', () => {
  const { db, tmpDir } = setupTestDb();

  try {
    const tableInfo = db.prepare('PRAGMA table_info(decision_events)').all();
    const chunkIdCol = tableInfo.find((col) => col.name === 'chunk_id');

    assert.ok(chunkIdCol, 'chunk_id column must exist in decision_events');
    assert.equal(
      chunkIdCol.type.toUpperCase(),
      'INTEGER',
      `Expected chunk_id type to be INTEGER, got ${chunkIdCol.type}`
    );
    assert.equal(chunkIdCol.notnull, 1, 'chunk_id must be NOT NULL');
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('7. safe schema migration converts legacy TEXT chunk_id column to INTEGER', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-migration-test-'));
  const dbPath = path.join(tmpDir, 'legacy.db');
  const rawDb = new Database(dbPath);

  try {
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('foreign_keys = ON');

    rawDb.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        relative_path TEXT UNIQUE NOT NULL,
        filename TEXT NOT NULL,
        category TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        total_lines INTEGER NOT NULL
      );

      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        source_location TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE decision_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        topic TEXT NOT NULL,
        value TEXT,
        actor_name TEXT,
        actor_organization TEXT,
        event_date TEXT,
        exact_quote TEXT NOT NULL,
        confidence REAL NOT NULL,
        verification_status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE event_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_event_id INTEGER NOT NULL REFERENCES decision_events(id) ON DELETE CASCADE,
        to_event_id INTEGER NOT NULL REFERENCES decision_events(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        explanation TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        document_id TEXT,
        relative_path TEXT NOT NULL,
        details TEXT
      );
    `);

    rawDb.prepare(`
      INSERT INTO documents VALUES ('doc_1', 'path/1.txt', '1.txt', 'email', '2024-01-01', 'h1', 10)
    `).run();
    rawDb.prepare(`
      INSERT INTO chunks VALUES ('101', 'doc_1', 0, 'Legacy quote text here', 1, 10, 'loc', '2024-01-01')
    `).run();
    rawDb.prepare(`
      INSERT INTO decision_events VALUES (
        1, '101', 'proposal', 'Legacy Topic', 'val', 'Actor', 'Org', '2024-01-01', 'Legacy quote text here', 0.9, 'candidate', '2024-01-01'
      )
    `).run();
    rawDb.prepare(`
      INSERT INTO decision_events VALUES (
        2, '101', 'commitment', 'Legacy Topic', 'val', 'Actor', 'Org', '2024-01-02', 'Legacy quote text here', 0.95, 'supported', '2024-01-02'
      )
    `).run();
    rawDb.prepare(`
      INSERT INTO event_relations VALUES (1, 2, 1, 'supports', 'Legacy relation', '2024-01-02')
    `).run();

    const preInfo = rawDb.prepare('PRAGMA table_info(decision_events)').all();
    const preCol = preInfo.find((c) => c.name === 'chunk_id');
    assert.equal(preCol.type.toUpperCase(), 'TEXT');

    rawDb.close();

    const migratedDb = initDatabase(dbPath);

    try {

      const postInfo = migratedDb.prepare('PRAGMA table_info(decision_events)').all();
      const postCol = postInfo.find((c) => c.name === 'chunk_id');
      assert.equal(postCol.type.toUpperCase(), 'INTEGER');

      const events = migratedDb.prepare('SELECT * FROM decision_events ORDER BY id ASC').all();
      assert.equal(events.length, 2);
      assert.equal(events[0].chunk_id, 101);
      assert.equal(events[0].topic, 'Legacy Topic');
      assert.equal(events[1].chunk_id, 101);

      const rels = migratedDb.prepare('SELECT * FROM event_relations').all();
      assert.equal(rels.length, 1);
      assert.equal(rels[0].relation_type, 'supports');

      migratedDb.prepare("DELETE FROM chunks WHERE id = '101'").run();
      assert.equal(migratedDb.prepare('SELECT COUNT(*) as c FROM decision_events').get().c, 0);
      assert.equal(migratedDb.prepare('SELECT COUNT(*) as c FROM event_relations').get().c, 0);
    } finally {
      migratedDb.close();
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
