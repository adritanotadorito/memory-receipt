import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase } from '../src/db.js';
import {
  scanCorpus,
  categorizeDocument,
  computeHash,
  generateDocId,
  generateChunkId,
  createLineBasedChunks,
  ingestCorpus,
} from '../src/ingest.js';

test('categorizeDocument correctly identifies document categories', () => {
  assert.equal(categorizeDocument('corpus/acme/emails/01_shelf-life-field-mapping.txt'), 'email');
  assert.equal(categorizeDocument('corpus/acme/reports/01_weekly-status-thread.txt'), 'report');
  assert.equal(categorizeDocument('corpus/acme/transcripts/01_2024-03-20_solution-demo.txt'), 'transcript');
  assert.equal(categorizeDocument('corpus/acme/00_README.md'), null);
  assert.equal(categorizeDocument('corpus/acme/PRACTICE-QUESTIONS.md'), null);
});

test('scanCorpus discovers exactly 45 txt documents and excludes specification markdown files', () => {
  const { validFiles, excludedFiles } = scanCorpus('corpus/acme');

  assert.equal(validFiles.length, 45);

  const categories = validFiles.reduce((acc, f) => {
    acc[f.category] = (acc[f.category] || 0) + 1;
    return acc;
  }, {});

  assert.equal(categories.email, 20);
  assert.equal(categories.report, 2);
  assert.equal(categories.transcript, 23);

  assert.ok(excludedFiles.some((f) => f.includes('00_README.md')));
  assert.ok(excludedFiles.some((f) => f.includes('PRACTICE-QUESTIONS.md')));
});

test('createLineBasedChunks generates exact line ranges, citations, and preserves source text verbatim', () => {
  const sampleLines = [];
  for (let i = 1; i <= 65; i++) {
    sampleLines.push(`Line ${i}: Content with special chars & numbers # ${i}`);
  }
  const rawText = sampleLines.join('\n');
  const relativePath = 'corpus/acme/transcripts/test-doc.txt';
  const docId = 'doc_test123';

  const chunks = createLineBasedChunks(rawText, relativePath, docId, 30, 10);

  assert.equal(chunks.length, 3);

  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 30);
  assert.equal(chunks[0].sourceLocation, 'corpus/acme/transcripts/test-doc.txt, lines 1-30');
  assert.equal(chunks[0].chunkText.split('\n').length, 30);
  assert.equal(chunks[0].chunkText.split('\n')[0], 'Line 1: Content with special chars & numbers # 1');
  assert.equal(chunks[0].chunkText.split('\n')[29], 'Line 30: Content with special chars & numbers # 30');

  assert.equal(chunks[1].startLine, 21);
  assert.equal(chunks[1].endLine, 50);
  assert.equal(chunks[1].sourceLocation, 'corpus/acme/transcripts/test-doc.txt, lines 21-50');

  assert.equal(chunks[2].startLine, 41);
  assert.equal(chunks[2].endLine, 65);
  assert.equal(chunks[2].sourceLocation, 'corpus/acme/transcripts/test-doc.txt, lines 41-65');
  assert.equal(chunks[2].chunkText.split('\n')[24], 'Line 65: Content with special chars & numbers # 65');
});

test('ingestCorpus is strictly idempotent and tracks audit logs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  try {

    const run1 = ingestCorpus(db, 'corpus/acme');
    assert.equal(run1.totalIndexedDocs, 45);
    assert.equal(run1.newDocsCount, 45);
    assert.equal(run1.updatedDocsCount, 0);
    assert.equal(run1.skippedDocsCount, 0);
    assert.equal(run1.errors.length, 0);

    const initialTotalChunks = run1.totalChunks;
    assert.ok(initialTotalChunks > 0);

    const auditCount1 = db.prepare('SELECT COUNT(*) as count FROM audit_log WHERE action = ?').get('INGEST');
    assert.equal(auditCount1.count, 45);

    const run2 = ingestCorpus(db, 'corpus/acme');
    assert.equal(run2.totalIndexedDocs, 45);
    assert.equal(run2.totalChunks, initialTotalChunks);
    assert.equal(run2.newDocsCount, 0);
    assert.equal(run2.updatedDocsCount, 0);
    assert.equal(run2.skippedDocsCount, 45);
    assert.equal(run2.errors.length, 0);

    const docCount = db.prepare('SELECT COUNT(*) as count FROM documents').get();
    const chunkCount = db.prepare('SELECT COUNT(*) as count FROM chunks').get();
    assert.equal(docCount.count, 45);
    assert.equal(chunkCount.count, initialTotalChunks);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ingestCorpus replaces old chunks and logs UPDATE when document content changes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-update-test-'));
  const corpusDir = path.join(tmpDir, 'corpus', 'acme', 'emails');
  fs.mkdirSync(corpusDir, { recursive: true });

  const testFile = path.join(corpusDir, '01_sample.txt');
  fs.writeFileSync(testFile, 'Line 1\nLine 2\nLine 3\n');

  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  try {

    const run1 = ingestCorpus(db, path.join(tmpDir, 'corpus', 'acme'));
    assert.equal(run1.newDocsCount, 1);
    assert.equal(run1.totalChunks, 1);

    let newContent = '';
    for (let i = 1; i <= 60; i++) {
      newContent += `Updated line ${i}\n`;
    }
    fs.writeFileSync(testFile, newContent);

    const run2 = ingestCorpus(db, path.join(tmpDir, 'corpus', 'acme'));
    assert.equal(run2.newDocsCount, 0);
    assert.equal(run2.updatedDocsCount, 1);
    assert.equal(run2.totalIndexedDocs, 1);

    const chunks = db.prepare('SELECT * FROM chunks').all();
    assert.ok(chunks.length > 1);
    assert.ok(chunks[0].chunk_text.startsWith('Updated line 1'));

    const updateLogs = db.prepare('SELECT * FROM audit_log WHERE action = ?').all('UPDATE');
    assert.equal(updateLogs.length, 1);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
