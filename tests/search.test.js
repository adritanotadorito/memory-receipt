import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase } from '../src/db.js';
import { ingestCorpus } from '../src/ingest.js';
import { searchChunks, prepareFtsQuery } from '../src/search.js';

test('prepareFtsQuery sanitizes and extracts meaningful search tokens', () => {
  assert.equal(prepareFtsQuery(''), '');
  assert.equal(prepareFtsQuery('   '), '');

  const query = 'What was agreed about UAT sign-off?';
  const fts = prepareFtsQuery(query);
  assert.ok(fts.includes('"agreed"*'));
  assert.ok(fts.includes('"uat"*'));
  assert.ok(fts.includes('"sign"*'));
  assert.ok(fts.includes('"off"*'));
});

test('search finds a chunk from the expected document for a clearly related query', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  try {
    ingestCorpus(db, 'corpus/acme');

    // Query relating specifically to UAT signoff
    const results = searchChunks(db, 'UAT sign-off', 8);

    assert.ok(results.length > 0);
    assert.ok(results.length <= 8);

    // Verify expected document appears in the top results
    const filenames = results.map((r) => r.filename);
    assert.ok(
      filenames.includes('15_uat-signoff.txt') ||
      filenames.includes('08_uat-readiness-review.txt') ||
      filenames.includes('16_fresh-uat-cover-briefing.txt')
    );

    // Verify required fields in all results
    for (const r of results) {
      assert.ok(r.chunkId);
      assert.ok(r.documentId);
      assert.ok(r.relativePath);
      assert.ok(r.category);
      assert.ok(r.sourceLocation);
      assert.ok(r.exactSourceText);
      assert.ok(r.snippet);
      assert.ok(typeof r.relevanceScore === 'number' && r.relevanceScore > 0);
      assert.match(r.sourceLocation, /lines \d+-\d+/);
    }
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('search never returns README or PRACTICE-QUESTIONS content', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-exclusion-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  try {
    ingestCorpus(db, 'corpus/acme');

    // Query terms that exist in PRACTICE-QUESTIONS.md (e.g. "Provenance", "P1", "P9", "weighting as the challenge")
    const results = searchChunks(db, 'weighting as the challenge provenance attribution', 8);

    for (const r of results) {
      assert.notEqual(r.filename, 'PRACTICE-QUESTIONS.md');
      assert.notEqual(r.filename, '00_README.md');
      assert.ok(!r.relativePath.includes('PRACTICE-QUESTIONS.md'));
      assert.ok(!r.relativePath.includes('00_README.md'));
    }
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('updating a document does not leave its old chunks searchable in FTS5', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-update-test-'));
  const corpusDir = path.join(tmpDir, 'corpus', 'acme', 'emails');
  fs.mkdirSync(corpusDir, { recursive: true });

  const testFile = path.join(corpusDir, '01_dynamic_test.txt');
  fs.writeFileSync(testFile, 'AlphaUniqueSecretPhraseOne\n');

  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  try {
    // Initial ingestion
    ingestCorpus(db, path.join(tmpDir, 'corpus', 'acme'));

    // Search for original unique phrase
    let initialSearch = searchChunks(db, 'AlphaUniqueSecretPhraseOne', 5);
    assert.equal(initialSearch.length, 1);
    assert.ok(initialSearch[0].exactSourceText.includes('AlphaUniqueSecretPhraseOne'));

    // Update document content completely
    fs.writeFileSync(testFile, 'BetaReplacedSecretPhraseTwo\n');

    // Re-ingest
    ingestCorpus(db, path.join(tmpDir, 'corpus', 'acme'));

    // Old phrase must NOT be searchable anymore
    const oldPhraseSearch = searchChunks(db, 'AlphaUniqueSecretPhraseOne', 5);
    assert.equal(oldPhraseSearch.length, 0);

    // New phrase MUST be searchable
    const newPhraseSearch = searchChunks(db, 'BetaReplacedSecretPhraseTwo', 5);
    assert.equal(newPhraseSearch.length, 1);
    assert.ok(newPhraseSearch[0].exactSourceText.includes('BetaReplacedSecretPhraseTwo'));
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
