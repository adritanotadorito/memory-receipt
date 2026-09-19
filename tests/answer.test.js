import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase } from '../src/db.js';
import { answerQuestion, parseAnswerResponse, ANSWER_SYSTEM_PROMPT } from '../src/answer.js';
import { createDecisionEvent } from '../src/ledger.js';

function setupAnswerTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  // 1. Seed transcript document
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

  // 2. Seed email document with conflicting shelf life proposals
  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_shelf', 'emails/05_shelf_life.txt', '05_shelf_life.txt', 'email', '2024-01-01', 'h_shelf', 30)
  `).run();

  const chunkShelf1Id = 'doc_shelf_c0001';
  const chunkShelf1Text = `Subject: Shelf-Life Field Mapping
From: Kwame Boateng <kwame@acme.org>
Date: 2024-03-15

We propose mapping shelf_life_days to the expiration_window field in ERP.`;

  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES (?, 'doc_shelf', 0, ?, 1, 12, 'emails/05_shelf_life.txt, lines 1-12', '2024-01-01')
  `).run(chunkShelf1Id, chunkShelf1Text);

  const chunkShelf2Id = 'doc_shelf_c0002';
  const chunkShelf2Text = `Subject: RE: Shelf-Life Field Mapping
From: Sofia Almeida <sofia@acme.org>
Date: 2024-03-18

Due to ERP schema constraints, we must map shelf_life_days to shelf_life_total instead.`;

  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES (?, 'doc_shelf', 1, ?, 13, 25, 'emails/05_shelf_life.txt, lines 13-25', '2024-01-01')
  `).run(chunkShelf2Id, chunkShelf2Text);

  // 3. Seed benchmark files that MUST be excluded from evidence packet
  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_readme', '00_README.md', '00_README.md', 'report', '2024-01-01', 'h_readme', 10)
  `).run();

  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_readme_c0001', 'doc_readme', 0, 'Internal benchmark rules and instructions for testing bakery scope and shelf life.', 1, 10, '00_README.md, lines 1-10', '2024-01-01')
  `).run();

  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_practice', 'PRACTICE-QUESTIONS.md', 'PRACTICE-QUESTIONS.md', 'report', '2024-01-01', 'h_practice', 10)
  `).run();

  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_practice_c0001', 'doc_practice', 0, 'Practice Question: What is bakery scope? Target Answer: Bakery is out of scope.', 1, 10, 'PRACTICE-QUESTIONS.md, lines 1-10', '2024-01-01')
  `).run();

  // 4. Seed decision events in the ledger
  const ev1 = createDecisionEvent(db, {
    chunk_id: chunkScopeId,
    event_type: 'status_claim',
    topic: 'bakery scope',
    value: 'out of scope',
    exact_quote: 'Bakery is out of scope for Phase 1.',
    confidence: 0.95,
    verification_status: 'candidate',
  });

  const ev2 = createDecisionEvent(db, {
    chunk_id: chunkShelf1Id,
    event_type: 'proposal',
    topic: 'shelf life mapping',
    value: 'expiration_window',
    actor_name: 'Kwame Boateng',
    event_date: '2024-03-15',
    exact_quote: 'We propose mapping shelf_life_days to the expiration_window field in ERP.',
    confidence: 0.9,
    verification_status: 'candidate',
  });

  const ev3 = createDecisionEvent(db, {
    chunk_id: chunkShelf2Id,
    event_type: 'reversal',
    topic: 'shelf life mapping',
    value: 'shelf_life_total',
    actor_name: 'Sofia Almeida',
    event_date: '2024-03-18',
    exact_quote: 'we must map shelf_life_days to shelf_life_total instead',
    confidence: 0.92,
    verification_status: 'candidate',
  });

  return {
    db,
    tmpDir,
    chunkScopeId,
    chunkScopeText,
    chunkShelf1Id,
    chunkShelf2Id,
    ev1,
    ev2,
    ev3,
  };
}

function cleanupAnswerTestDb(db, tmpDir) {
  try {
    db.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

test('1. valid receipt IDs resolve to stored literal quotes and physical citations', async () => {
  const { db, tmpDir, ev1, chunkScopeId } = setupAnswerTestDb();

  let capturedPrompt = null;
  const mockLlm = async (messages) => {
    capturedPrompt = messages[1].content;
    return {
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
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      model: 'mock-gpt-4o',
    };
  };

  try {
    const result = await answerQuestion(db, 'What is the decision on bakery scope?', mockLlm);

    assert.equal(result.status, 'answered');
    assert.equal(result.answer, 'Bakery is out of scope for Phase 1.');
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].text, 'Bakery is out of scope for Phase 1');
    assert.deepEqual(result.claims[0].receipt_ids, [`event-${ev1.id}`]);

    // Code attached literal quote from database
    assert.equal(result.claims[0].evidence_quote, 'Bakery is out of scope for Phase 1.');
    assert.equal(result.claims[0].currency, 'current');
    assert.equal(result.claims[0].receipts.length, 1);
    assert.equal(result.claims[0].receipts[0].exactQuote, 'Bakery is out of scope for Phase 1.');

    // Citations validation
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].citationNumber, 1);
    assert.equal(result.citations[0].receiptId, `event-${ev1.id}`);
    assert.equal(result.citations[0].chunkId, chunkScopeId);
    assert.equal(result.citations[0].relativePath, 'transcripts/02_scope.txt');
    assert.equal(result.citations[0].sourceLocation, 'transcripts/02_scope.txt, lines 1-15');
    assert.equal(result.citations[0].startLine, 1);
    assert.equal(result.citations[0].endLine, 15);
    assert.equal(result.citations[0].exactQuote, 'Bakery is out of scope for Phase 1.');

    // Verify prompt contained receipt collection
    assert.ok(capturedPrompt.includes(`[Receipt ID: event-${ev1.id}]`));
    assert.ok(capturedPrompt.includes('Quote: "Bakery is out of scope for Phase 1."'));
  } finally {
    cleanupAnswerTestDb(db, tmpDir);
  }
});

test('2. invented receipt ID is rejected and safely falls back when no valid claims remain', async () => {
  const { db, tmpDir } = setupAnswerTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      status: 'answered',
      answer: 'Bakery was canceled in a secret meeting.',
      claims: [
        {
          text: 'Secret meeting canceled bakery',
          receipt_ids: ['event-99999'], // Hallucinated receipt ID
          currency: 'current',
        },
      ],
      reasoning_note: null,
    }),
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    model: 'mock-gpt-4o',
  });

  try {
    const result = await answerQuestion(db, 'What is the decision on bakery scope?', mockLlm);

    assert.equal(result.status, 'insufficient_evidence');
    assert.equal(result.citations.length, 0);
    assert.equal(result.claims.length, 0);
    assert.ok(result.reasoningNote.includes('invalid receipt IDs') || result.reasoningNote.includes('zero verifiable claims'));
  } finally {
    cleanupAnswerTestDb(db, tmpDir);
  }
});

test('3. one invalid claim does not erase separate valid claims', async () => {
  const { db, tmpDir, ev1 } = setupAnswerTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      status: 'answered',
      answer: 'Bakery is out of scope for Phase 1.',
      claims: [
        {
          text: 'Invented assertion with fake receipt',
          receipt_ids: ['event-99999'], // Invalid receipt ID
          currency: 'current',
        },
        {
          text: 'Bakery is out of scope for Phase 1',
          receipt_ids: [`event-${ev1.id}`], // Valid receipt ID
          currency: 'current',
        },
      ],
      reasoning_note: null,
    }),
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    model: 'mock-gpt-4o',
  });

  try {
    const result = await answerQuestion(db, 'What is the decision on bakery scope?', mockLlm);

    // Answer is preserved because 1 valid claim succeeded
    assert.equal(result.status, 'answered');
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].text, 'Bakery is out of scope for Phase 1');
    assert.deepEqual(result.claims[0].receipt_ids, [`event-${ev1.id}`]);
    assert.equal(result.claims[0].evidence_quote, 'Bakery is out of scope for Phase 1.');
    assert.equal(result.citations.length, 1);
  } finally {
    cleanupAnswerTestDb(db, tmpDir);
  }
});

test('4. conflicting evidence status with multiple receipts preserves both historical and current claims', async () => {
  const { db, tmpDir, ev2, ev3 } = setupAnswerTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      status: 'conflicting_evidence',
      answer: 'Initial emails proposed mapping shelf_life_days to expiration_window, but a subsequent email reversed this to shelf_life_total.',
      claims: [
        {
          text: 'Kwame Boateng proposed mapping shelf_life_days to expiration_window',
          receipt_ids: [`event-${ev2.id}`],
          currency: 'historical',
        },
        {
          text: 'Sofia Almeida stated that ERP schema requires mapping to shelf_life_total',
          receipt_ids: [`event-${ev3.id}`],
          currency: 'current',
        },
      ],
      reasoning_note: 'An initial proposal was revised due to ERP schema constraints; final production signoff is pending.',
    }),
    usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
    model: 'mock-gpt-4o',
  });

  try {
    const result = await answerQuestion(db, 'What is the shelf life field mapping in ERP?', mockLlm);

    assert.equal(result.status, 'conflicting_evidence');
    assert.equal(result.claims.length, 2);
    assert.equal(result.claims[0].currency, 'historical');
    assert.equal(result.claims[0].evidence_quote, 'We propose mapping shelf_life_days to the expiration_window field in ERP.');
    assert.equal(result.claims[1].currency, 'current');
    assert.equal(result.claims[1].evidence_quote, 'we must map shelf_life_days to shelf_life_total instead');
    assert.equal(result.reasoningNote, 'An initial proposal was revised due to ERP schema constraints; final production signoff is pending.');
    assert.equal(result.citations.length, 2);
  } finally {
    cleanupAnswerTestDb(db, tmpDir);
  }
});

test('5. answer falls back to insufficient_evidence only when no supported claim remains', async () => {
  const { db, tmpDir } = setupAnswerTestDb();

  // Scenario A: Chunks are retrieved, but LLM determines evidence is insufficient
  const mockLlmInsufficient = async () => ({
    text: JSON.stringify({
      status: 'insufficient_evidence',
      answer: 'There is insufficient detail in the retrieved receipts to determine the packaging vendor.',
      claims: [],
      reasoning_note: 'No receipts specify the packaging vendor.',
    }),
    usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    model: 'mock-gpt-4o',
  });

  const resultA = await answerQuestion(db, 'Who is the bakery packaging vendor?', mockLlmInsufficient);
  assert.equal(resultA.status, 'insufficient_evidence');
  assert.equal(resultA.claims.length, 0);
  assert.equal(resultA.citations.length, 0);
  assert.equal(resultA.reasoningNote, 'No receipts specify the packaging vendor.');

  // Scenario B: Zero matching chunks found in hybrid search
  const resultB = await answerQuestion(db, 'What is the aircraft fleet maintenance schedule?', mockLlmInsufficient);
  assert.equal(resultB.status, 'insufficient_evidence');
  assert.equal(resultB.claims.length, 0);
  assert.equal(resultB.citations.length, 0);
  assert.equal(resultB.reasoningNote, 'Hybrid search returned zero matching chunks.');

  cleanupAnswerTestDb(db, tmpDir);
});

test('6. README and practice questions never enter the receipts or evidence packet', async () => {
  const { db, tmpDir } = setupAnswerTestDb();

  let capturedPrompt = '';
  const mockLlm = async (messages) => {
    capturedPrompt = messages[1].content;
    return {
      text: JSON.stringify({
        status: 'answered',
        answer: 'Bakery is out of scope for Phase 1.',
        claims: [
          {
            text: 'Bakery is out of scope for Phase 1',
            receipt_ids: ['event-1'],
            currency: 'current',
          },
        ],
        reasoning_note: null,
      }),
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      model: 'mock-gpt-4o',
    };
  };

  try {
    await answerQuestion(db, 'What is the bakery scope?', mockLlm);

    // Verify benchmark files never entered prompt
    assert.ok(!capturedPrompt.includes('00_README.md'), 'Evidence packet must NOT include 00_README.md');
    assert.ok(!capturedPrompt.includes('PRACTICE-QUESTIONS.md'), 'Evidence packet must NOT include PRACTICE-QUESTIONS.md');
    assert.ok(!capturedPrompt.includes('Internal benchmark rules'), 'Evidence packet must NOT include benchmark text');
    assert.ok(!capturedPrompt.includes('Practice Question:'), 'Evidence packet must NOT include practice questions text');

    // Verify legitimate transcript chunk WAS included
    assert.ok(capturedPrompt.includes('transcripts/02_scope.txt'));
  } finally {
    cleanupAnswerTestDb(db, tmpDir);
  }
});

test('7. parseAnswerResponse handles raw JSON, markdown blocks, and invalid JSON', () => {
  const validJson = JSON.stringify({
    status: 'answered',
    answer: 'Direct answer',
    claims: [],
    reasoning_note: null,
  });

  // Plain JSON
  const r1 = parseAnswerResponse(validJson);
  assert.equal(r1.status, 'answered');
  assert.equal(r1.answer, 'Direct answer');

  // Markdown code fence with json identifier
  const r2 = parseAnswerResponse(`\`\`\`json\n${validJson}\n\`\`\``);
  assert.equal(r2.status, 'answered');

  // Markdown code fence without json identifier
  const r3 = parseAnswerResponse(`\`\`\`\n${validJson}\n\`\`\``);
  assert.equal(r3.status, 'answered');

  // Conversational preamble surrounding JSON
  const r4 = parseAnswerResponse(`Here is the result:\n${validJson}\nHope that helps!`);
  assert.equal(r4.status, 'answered');

  // Invalid JSON strings
  assert.equal(parseAnswerResponse(''), null);
  assert.equal(parseAnswerResponse(null), null);
  assert.equal(parseAnswerResponse('not a json string'), null);
});

test('8. rejects empty or invalid question input', async () => {
  const { db, tmpDir } = setupAnswerTestDb();

  try {
    await assert.rejects(() => answerQuestion(db, ''), /question must be a non-empty string/);
    await assert.rejects(() => answerQuestion(db, '   '), /question must be a non-empty string/);
    await assert.rejects(() => answerQuestion(db, null), /question must be a non-empty string/);
  } finally {
    cleanupAnswerTestDb(db, tmpDir);
  }
});
