import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase, ensureSeededDatabase } from '../src/db.js';
import { createApp, buildFocusedGraph } from '../src/server.js';
import { createDecisionEvent } from '../src/ledger.js';

function setupServerTestEnvironment() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_scope', 'transcripts/02_scope.txt', '02_scope.txt', 'transcript', '2024-01-01', 'h_scope', 30)
  `).run();

  const chunkScopeId = 'doc_scope_c0001';
  const chunkScopeText = `Ana Duarte: Welcome everyone. Let's confirm the scope for dairy and chilled ready meals.
Unknown Speaker: Yes, Bakery is out of scope for Phase 1.
Nadia Haddad: Understood, bakery remains out of scope until Q3.`;

  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES (?, 'doc_scope', 0, ?, 1, 15, 'transcripts/02_scope.txt, lines 1-15', '2024-01-01')
  `).run(chunkScopeId, chunkScopeText);

  const ev1 = createDecisionEvent(db, {
    chunk_id: chunkScopeId,
    event_type: 'status_claim',
    topic: 'bakery scope',
    value: 'out of scope',
    actor_name: 'Unknown Speaker',
    event_date: '2024-03-15',
    exact_quote: 'Bakery is out of scope for Phase 1.',
    confidence: 0.95,
    verification_status: 'candidate',
  });

  const mockLlm = async () => ({
    text: JSON.stringify({
      status: 'answered',
      answer: 'Bakery is out of scope for Phase 1.',
      claims: [
        {
          text: 'Bakery is out of scope for Phase 1',
          receipt_ids: [`event-${ev1.id}`],
          currency: 'current',
        },
      ],
      reasoning_note: null,
    }),
    usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    model: 'mock-gpt-4o',
  });

  const app = createApp(db, mockLlm);
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    db,
    tmpDir,
    server,
    baseUrl,
    ev1,
    chunkScopeId,
  };
}

function cleanupServerTestEnvironment({ db, tmpDir, server }) {
  try {
    server.close();
  } catch {}
  try {
    db.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

test('1. GET /api/health returns ok: true', async () => {
  const env = setupServerTestEnvironment();
  try {
    const res = await fetch(`${env.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.timestamp);
  } finally {
    cleanupServerTestEnvironment(env);
  }
});

test('2. POST /api/ask returns grounded answer, receipts, and focused Cytoscape graph', async () => {
  const env = setupServerTestEnvironment();
  try {
    const res = await fetch(`${env.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is the decision on bakery scope?' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    const data = body.data;
    assert.equal(data.status, 'answered');
    assert.equal(data.answer, 'Bakery is out of scope for Phase 1.');
    assert.equal(data.claims.length, 1);
    assert.equal(data.claims[0].evidence_quote, 'Bakery is out of scope for Phase 1.');
    assert.equal(data.citations.length, 1);

    assert.ok(data.graph, 'Graph payload must be generated');
    assert.ok(Array.isArray(data.graph.nodes));
    assert.ok(Array.isArray(data.graph.edges));
    assert.ok(data.graph.nodes.length >= 2, 'Graph should include event and document nodes');
    assert.ok(data.graph.edges.length >= 1, 'Graph should include source attribution edges');

    const eventNode = data.graph.nodes.find((n) => n.data.nodeType === 'event');
    assert.ok(eventNode);
    assert.equal(eventNode.data.id, `event-${env.ev1.id}`);
    assert.equal(eventNode.data.currency, 'current');

    const docNode = data.graph.nodes.find((n) => n.data.nodeType === 'document');
    assert.ok(docNode);

    assert.ok(data.metrics, 'data.metrics must be returned');
    assert.ok(Number.isFinite(data.metrics.retrievedChunkCount), 'retrievedChunkCount must be finite number');
    assert.ok(Number.isFinite(data.metrics.includedChunkCount), 'includedChunkCount must be finite number');
    assert.ok(Number.isFinite(data.metrics.evidenceCharCount), 'evidenceCharCount must be finite number');
    assert.ok(Number.isFinite(data.metrics.promptTokens), 'promptTokens must be finite number');
    assert.ok(Number.isFinite(data.metrics.completionTokens), 'completionTokens must be finite number');
    assert.ok(Number.isFinite(data.metrics.totalTokens), 'totalTokens must be finite number');
  } finally {
    cleanupServerTestEnvironment(env);
  }
});

test('3. POST /api/ask validates non-empty question string', async () => {
  const env = setupServerTestEnvironment();
  try {
    const res = await fetch(`${env.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '   ' }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('non-empty string'));
  } finally {
    cleanupServerTestEnvironment(env);
  }
});

test('4. POST /api/deletion/preview returns affected counts without modifying database', async () => {
  const env = setupServerTestEnvironment();
  try {
    const res = await fetch(`${env.baseUrl}/api/deletion/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personName: 'Ana Duarte' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.targetName, 'Ana Duarte');
    assert.equal(body.data.affectedChunksCount, 1);

    const count = env.db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
    assert.equal(count, 1);
  } finally {
    cleanupServerTestEnvironment(env);
  }
});

test('5. POST /api/deletion/confirm requires confirmed: true protection flag', async () => {
  const env = setupServerTestEnvironment();
  try {

    const res = await fetch(`${env.baseUrl}/api/deletion/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personName: 'Ana Duarte', confirmed: false }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('explicit confirmation'));

    const count = env.db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
    assert.equal(count, 1);
  } finally {
    cleanupServerTestEnvironment(env);
  }
});

test('6. POST /api/deletion/confirm permanently purges data when confirmed is true', async () => {
  const env = setupServerTestEnvironment();
  try {
    const res = await fetch(`${env.baseUrl}/api/deletion/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personName: 'Ana Duarte', confirmed: true }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.deletedChunksCount, 1);
    assert.equal(body.data.verification.verified, true);
    assert.equal(body.data.verification.remainingChunks, 0);

    const count = env.db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
    assert.equal(count, 0);
  } finally {
    cleanupServerTestEnvironment(env);
  }
});

test('7. ensureSeededDatabase copies seed file when target database does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
  const targetDb = path.join(tmpDir, 'data', 'memory.db');
  const mockSeed = path.join(tmpDir, 'seed.db');
  fs.writeFileSync(mockSeed, 'mock-sqlite-seed-data');

  try {
    const result = ensureSeededDatabase(targetDb, mockSeed);
    assert.equal(result, true);
    assert.equal(fs.existsSync(targetDb), true);
    assert.equal(fs.readFileSync(targetDb, 'utf8'), 'mock-sqlite-seed-data');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('8. ensureSeededDatabase does not overwrite existing target database', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
  const targetDb = path.join(tmpDir, 'target.db');
  const mockSeed = path.join(tmpDir, 'seed.db');
  fs.writeFileSync(targetDb, 'existing-runtime-data-with-deletions');
  fs.writeFileSync(mockSeed, 'pristine-seed-data');

  try {
    const result = ensureSeededDatabase(targetDb, mockSeed);
    assert.equal(result, false);

    assert.equal(fs.readFileSync(targetDb, 'utf8'), 'existing-runtime-data-with-deletions');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('9. ensureSeededDatabase safely ignores :memory: paths', () => {
  const result = ensureSeededDatabase(':memory:');
  assert.equal(result, false);
});
