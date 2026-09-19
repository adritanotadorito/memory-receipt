import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase } from '../src/db.js';
import { extractEventsFromChunk, extractAllChunks, parseModelJson } from '../src/extract-events.js';

function setupTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_01', 'emails/01_shelf.txt', '01_shelf.txt', 'email', '2024-01-01', 'h1', 30)
  `).run();

  const chunk1Id = 'doc_01_c0001';
  const chunk1Text = `Subject: Shelf-Life Field Mapping Discussion
From: Kwame Boateng <kwame@acme.org>
Date: 2024-03-15

We are proposing to map shelf_life_days to the expiration_window field in ERP.
Sofia agreed that this avoids duplicate date calculations during the warehouse migration.`;

  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES (?, 'doc_01', 0, ?, 1, 10, 'emails/01_shelf.txt, lines 1-10', '2024-01-01')
  `).run(chunk1Id, chunk1Text);

  const chunk2Id = 'doc_01_c0002';
  const chunk2Text = `Ana Duarte 31 seconds
Configuration. Nadia.
Nadia Haddad 38 seconds
Okay, yeah.
Unknown Speaker 41 seconds
Yes for produce, so dairy and chilled ready meals. Bakery Bakery is out of scope.
Ana Duarte 50 seconds
Shelf life logic.`;

  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES (?, 'doc_01', 1, ?, 11, 20, 'emails/01_shelf.txt, lines 11-20', '2024-01-01')
  `).run(chunk2Id, chunk2Text);

  return { db, tmpDir, chunk1Id, chunk1Text, chunk2Id, chunk2Text };
}

function cleanupTestDb(db, tmpDir) {
  try {
    db.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

test('1. structured { events: [...] } output gets inserted as candidate', async () => {
  const { db, tmpDir, chunk1Id } = setupTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      events: [
        {
          event_type: 'proposal',
          topic: 'shelf life mapping',
          value: 'shelf_life_days -> expiration_window',
          actor_name: 'Kwame Boateng',
          actor_organization: 'Acme Logistics',
          event_date: '2024-03-15',
          exact_quote: 'We are proposing to map shelf_life_days to the expiration_window field in ERP.',
          confidence: 0.95,
        },
      ],
    }),
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'mock-gpt-4',
  });

  try {
    const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunk1Id);
    const result = await extractEventsFromChunk(db, chunk, mockLlm);

    assert.equal(result.skipped, false);
    assert.equal(result.inserted.length, 1);
    assert.equal(result.duplicatesCount, 0);
    assert.equal(result.rejectedQuotesCount, 0);
    assert.equal(result.missingTopicCount, 0);
    assert.equal(result.invalidSchemaCount, 0);

    const events = db.prepare('SELECT * FROM decision_events WHERE chunk_id = ?').all(chunk1Id);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'proposal');
    assert.equal(events[0].topic, 'shelf life mapping');
    assert.equal(events[0].verification_status, 'candidate');
    assert.equal(events[0].exact_quote, 'We are proposing to map shelf_life_days to the expiration_window field in ERP.');
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('2. extracts "Bakery is out of scope" scope decision event', async () => {
  const { db, tmpDir, chunk2Id } = setupTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      events: [
        {
          event_type: 'status_claim',
          topic: 'bakery scope',
          value: 'out of scope',
          actor_name: null,
          actor_organization: null,
          event_date: null,
          exact_quote: 'Bakery Bakery is out of scope.',
          confidence: 0.95,
        },
      ],
    }),
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'mock-gpt-4',
  });

  try {
    const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunk2Id);
    const result = await extractEventsFromChunk(db, chunk, mockLlm);

    assert.equal(result.inserted.length, 1);
    assert.equal(result.rejectedQuotesCount, 0);

    const events = db.prepare('SELECT * FROM decision_events WHERE chunk_id = ?').all(chunk2Id);
    assert.equal(events.length, 1);
    assert.equal(events[0].topic, 'bakery scope');
    assert.equal(events[0].exact_quote, 'Bakery Bakery is out of scope.');
    assert.equal(events[0].value, 'out of scope');
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('3. alias mapping maps actor and date correctly when actor_name/event_date absent', async () => {
  const { db, tmpDir, chunk1Id } = setupTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      events: [
        {
          event_type: 'commitment',
          topic: 'migration date avoidance',
          actor: 'Sofia',
          date: '2024-03-15',
          exact_quote: 'Sofia agreed that this avoids duplicate date calculations during the warehouse migration.',
          confidence: 0.9,
        },
      ],
    }),
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'mock-gpt-4',
  });

  try {
    const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunk1Id);
    const result = await extractEventsFromChunk(db, chunk, mockLlm);

    assert.equal(result.inserted.length, 1);
    const saved = db.prepare('SELECT * FROM decision_events WHERE chunk_id = ?').get(chunk1Id);
    assert.equal(saved.actor_name, 'Sofia');
    assert.equal(saved.event_date, '2024-03-15');
    assert.equal(saved.topic, 'migration date avoidance');
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('4. rejects events missing topic and counts them in missingTopicCount', async () => {
  const { db, tmpDir, chunk1Id } = setupTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      events: [
        {
          event_type: 'proposal',
          topic: '',
          exact_quote: 'We are proposing to map shelf_life_days to the expiration_window field in ERP.',
          confidence: 0.9,
        },
        {
          event_type: 'commitment',

          exact_quote: 'Sofia agreed that this avoids duplicate date calculations during the warehouse migration.',
          confidence: 0.9,
        },
      ],
    }),
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'mock-gpt-4',
  });

  try {
    const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunk1Id);
    const result = await extractEventsFromChunk(db, chunk, mockLlm);

    assert.equal(result.inserted.length, 0);
    assert.equal(result.missingTopicCount, 2);
    assert.equal(result.rejectedQuotesCount, 0);

    const count = db.prepare('SELECT COUNT(*) as count FROM decision_events WHERE chunk_id = ?').get(chunk1Id);
    assert.equal(count.count, 0);
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('5. force rerun reprocesses chunks without creating duplicate decision events', async () => {
  const { db, tmpDir } = setupTestDb();

  let llmCalls = 0;
  const mockLlm = async () => {
    llmCalls++;
    return {
      text: JSON.stringify({
        events: [
          {
            event_type: 'proposal',
            topic: 'shelf life mapping',
            exact_quote: 'We are proposing to map shelf_life_days to the expiration_window field in ERP.',
            confidence: 0.95,
          },
        ],
      }),
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      model: 'mock-gpt-4',
    };
  };

  try {

    const summary1 = await extractAllChunks(db, { llm: mockLlm, resume: true, force: false });
    assert.equal(summary1.processedChunks, 2);
    assert.equal(summary1.candidateEventsInserted, 1);
    assert.equal(summary1.invalidQuotesRejected, 1);
    assert.equal(llmCalls, 2);

    const initialEvents = db.prepare('SELECT COUNT(*) as count FROM decision_events').get().count;
    assert.equal(initialEvents, 1);

    const summary2 = await extractAllChunks(db, { llm: mockLlm, force: true });
    assert.equal(summary2.processedChunks, 2);
    assert.equal(summary2.candidateEventsInserted, 0);
    assert.equal(summary2.duplicatesSkipped, 1);
    assert.equal(summary2.invalidQuotesRejected, 1);
    assert.equal(llmCalls, 4);

    const finalEvents = db.prepare('SELECT COUNT(*) as count FROM decision_events').get().count;
    assert.equal(finalEvents, 1);
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('6. deleting a chunk cascades to its extraction record and decision events', async () => {
  const { db, tmpDir, chunk1Id } = setupTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      events: [
        {
          event_type: 'proposal',
          topic: 'cascade extraction test',
          exact_quote: 'We are proposing to map shelf_life_days to the expiration_window field in ERP.',
          confidence: 0.95,
        },
      ],
    }),
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'mock-gpt-4',
  });

  try {
    const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunk1Id);
    await extractEventsFromChunk(db, chunk, mockLlm);

    assert.equal(db.prepare('SELECT COUNT(*) as count FROM decision_events WHERE chunk_id = ?').get(chunk1Id).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM chunk_extractions WHERE chunk_id = ?').get(chunk1Id).count, 1);

    db.prepare('DELETE FROM chunks WHERE id = ?').run(chunk1Id);

    assert.equal(db.prepare('SELECT COUNT(*) as count FROM decision_events WHERE chunk_id = ?').get(chunk1Id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM chunk_extractions WHERE chunk_id = ?').get(chunk1Id).count, 0);
  } finally {
    cleanupTestDb(db, tmpDir);
  }
});

test('7. parseModelJson handles structured root objects, arrays, and markdown fences', () => {
  assert.deepEqual(parseModelJson(''), []);
  assert.deepEqual(parseModelJson('{"events": [{"topic": "T1"}]}'), [{ topic: 'T1' }]);
  assert.deepEqual(parseModelJson('```json\n{"events": [{"topic": "T2"}]}\n```'), [{ topic: 'T2' }]);
  assert.deepEqual(parseModelJson('```json\n[{"topic": "T3"}]\n```'), [{ topic: 'T3' }]);
  assert.deepEqual(parseModelJson('Here is the structured output: {"events": [{"topic": "T4"}]}'), [{ topic: 'T4' }]);
});
