import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase } from '../src/db.js';
import { ingestCorpus } from '../src/ingest.js';
import {
  generateEmbedding,
  dotProduct,
  embedCorpusChunks,
  semanticSearch,
  DEFAULT_MODEL_NAME,
} from '../src/embeddings.js';
import { hybridSearch } from '../src/hybrid.js';

test('generateEmbedding produces a normalized 384-dimensional vector', async () => {
  const text = 'This is a sample text for semantic embedding validation.';
  const vector = await generateEmbedding(text);

  assert.ok(Array.isArray(vector));
  assert.equal(vector.length, 384);

  const normSq = vector.reduce((sum, val) => sum + val * val, 0);
  assert.ok(Math.abs(normSq - 1.0) < 0.01, `Expected norm ~1.0, got ${normSq}`);
});

test('every indexed chunk gets exactly one embedding and rerunning creates no duplicates', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  try {

    const corpusDir = path.join(tmpDir, 'corpus', 'acme', 'transcripts');
    fs.mkdirSync(corpusDir, { recursive: true });
    fs.writeFileSync(path.join(corpusDir, '01_test.txt'), 'Meeting discussing warehouse shelf life parameters and delivery dates.\n'.repeat(40));

    ingestCorpus(db, path.join(tmpDir, 'corpus', 'acme'));

    const chunkCount = db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
    assert.ok(chunkCount > 0);

    const run1 = await embedCorpusChunks(db, { batchSize: 16 });
    assert.equal(run1.newEmbeddedCount, chunkCount);
    assert.equal(run1.skippedCount, 0);

    const embedCount1 = db.prepare('SELECT COUNT(*) as count FROM chunk_embeddings').get().count;
    assert.equal(embedCount1, chunkCount);

    const run2 = await embedCorpusChunks(db, { batchSize: 16 });
    assert.equal(run2.newEmbeddedCount, 0);
    assert.equal(run2.skippedCount, chunkCount);

    const embedCount2 = db.prepare('SELECT COUNT(*) as count FROM chunk_embeddings').get().count;
    assert.equal(embedCount2, chunkCount);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('semantic search retrieves relevant results with complete citation metadata', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-search-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  try {
    const corpusDir = path.join(tmpDir, 'corpus', 'acme', 'emails');
    fs.mkdirSync(corpusDir, { recursive: true });

    const opIdContent = [
      'Subject: OP_ID field - exclusion from fresh feed',
      'The waste write-off extract currently includes OP_ID, a six digit operator identifier identifying the staff member who scanned the item.',
      'We agreed to remove OP_ID from the daily export starting this Friday to maintain data privacy compliance.',
      'Staff scanning numbers will no longer be logged or transferred in the feed.'
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(corpusDir, '07_op-id-field-exclusion.txt'), opIdContent);

    const bakeryContent = [
      'Subject: Bakery equipment maintenance',
      'Bakery equipment procurement and oven temperature maintenance schedules for all regional stores.',
      'Quarterly heating checks must be completed by the facilities team.'
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(corpusDir, '10_unrelated.txt'), bakeryContent);

    ingestCorpus(db, path.join(tmpDir, 'corpus', 'acme'));
    await embedCorpusChunks(db);

    const results = await semanticSearch(db, 'staff scanning badge numbers in waste log', 5);

    assert.ok(results.length > 0);
    assert.equal(results[0].filename, '07_op-id-field-exclusion.txt');
    assert.ok(results[0].similarityScore > 0.2);

    assert.ok(results[0].chunkId);
    assert.ok(results[0].documentId);
    assert.ok(results[0].relativePath);
    assert.ok(results[0].sourceLocation.includes('lines'));
    assert.ok(results[0].exactSourceText);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('hybrid search combines keyword and semantic rankings with source attribution', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-fusion-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  try {
    const corpusDir = path.join(tmpDir, 'corpus', 'acme', 'emails');
    fs.mkdirSync(corpusDir, { recursive: true });

    fs.writeFileSync(
      path.join(corpusDir, '15_uat-signoff.txt'),
      'Acme Org confirms that user acceptance testing for core replenishment has been completed and signed off.\n'.repeat(20)
    );

    ingestCorpus(db, path.join(tmpDir, 'corpus', 'acme'));
    await embedCorpusChunks(db);

    const results = await hybridSearch(db, 'Who approved user acceptance testing for core replenishment?', { limit: 5 });

    assert.ok(results.length > 0);
    assert.equal(results[0].filename, '15_uat-signoff.txt');
    assert.ok(['both', 'keyword', 'semantic'].includes(results[0].retrievalSource));
    assert.ok(results[0].hybridScore > 0);
    assert.ok(results[0].sourceLocation.includes('lines'));
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
