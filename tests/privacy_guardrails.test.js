import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase } from '../src/db.js';
import { answerQuestion } from '../src/answer.js';
import { logLlmUsage, getUsageSummary } from '../src/usage.js';
import { createApp } from '../src/server.js';
import { createDecisionEvent } from '../src/ledger.js';

function setupGuardrailsTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_arch', 'transcripts/01_arch.txt', '01_arch.txt', 'transcript', '2024-01-01', 'h_arch', 100)
  `).run();

  const chunk1Text = 'Ana Duarte: The primary database architecture decision is PostgreSQL on AWS RDS with WAL archiving enabled.';
  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_arch_c0001', 'doc_arch', 0, ?, 1, 10, 'transcripts/01_arch.txt, lines 1-10', '2024-01-01')
  `).run(chunk1Text);

  const chunk2Text = 'Carlos Mendes: We also evaluated SQLite and CockroachDB, but finalized PostgreSQL due to existing team operational experience.';
  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_arch_c0002', 'doc_arch', 1, ?, 11, 25, 'transcripts/01_arch.txt, lines 11-25', '2024-01-01')
  `).run(chunk2Text);

  const chunk3Text = 'Nadia Haddad: Backup retention policy is set to 30 days point-in-time recovery with daily snapshots exported to cold storage.';
  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_arch_c0003', 'doc_arch', 2, ?, 26, 40, 'transcripts/01_arch.txt, lines 26-40', '2024-01-01')
  `).run(chunk3Text);

  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_readme', '00_README.md', '00_README.md', 'report', '2024-01-01', 'h_readme', 10)
  `).run();
  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_readme_c0001', 'doc_readme', 0, 'Internal benchmark rules for database architecture evaluation.', 1, 10, '00_README.md, lines 1-10', '2024-01-01')
  `).run();

  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_practice', 'PRACTICE-QUESTIONS.md', 'PRACTICE-QUESTIONS.md', 'report', '2024-01-01', 'h_practice', 10)
  `).run();
  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_practice_c0001', 'doc_practice', 0, 'Practice: What is the database architecture? Target: PostgreSQL RDS.', 1, 10, 'PRACTICE-QUESTIONS.md, lines 1-10', '2024-01-01')
  `).run();

  const ev1 = createDecisionEvent(db, {
    chunk_id: 'doc_arch_c0001',
    event_type: 'commitment',
    topic: 'database architecture',
    value: 'PostgreSQL RDS',
    actor_name: 'Ana Duarte',
    event_date: '2024-01-15',
    exact_quote: 'The primary database architecture decision is PostgreSQL on AWS RDS with WAL archiving enabled.',
    confidence: 0.95,
    verification_status: 'candidate',
  });

  return { db, tmpDir, ev1 };
}

function cleanupGuardrailsTestDb(db, tmpDir) {
  try {
    db.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

test('1. evidence packing bounds total character count by MAX_EVIDENCE_CHARS without breaking chunk boundaries', async () => {
  const { db, tmpDir, ev1 } = setupGuardrailsTestDb();

  let capturedPrompt = '';
  const mockLlm = async (messages) => {
    capturedPrompt = messages[1].content;
    return {
      text: JSON.stringify({
        status: 'answered',
        answer: 'PostgreSQL on AWS RDS was selected.',
        claims: [
          {
            text: 'PostgreSQL on AWS RDS was selected',
            receipt_ids: [`event-${ev1.id}`],
            currency: 'current',
          },
        ],
        reasoning_note: null,
      }),
      usage: { prompt_tokens: 45, completion_tokens: 25, total_tokens: 70 },
      model: 'gpt-4.1-mini',
    };
  };

  try {

    const result = await answerQuestion(db, 'What is the database architecture?', mockLlm, {
      maxEvidenceChars: 150,
      limit: 5,
    });

    assert.equal(result.status, 'answered');
    assert.equal(result.metrics.includedChunkCount, 1, 'Only 1 chunk should fit within 150 chars budget');
    assert.ok(result.metrics.retrievedChunkCount >= 1);
    assert.ok(result.metrics.evidenceCharCount > 0);

    assert.ok(capturedPrompt.includes('The primary database architecture decision is PostgreSQL on AWS RDS with WAL archiving enabled.'));

    assert.ok(!capturedPrompt.includes('Carlos Mendes: We also evaluated SQLite'));
  } finally {
    cleanupGuardrailsTestDb(db, tmpDir);
  }
});

test('2. evidence packing includes first chunk in full even if it alone exceeds MAX_EVIDENCE_CHARS', async () => {
  const { db, tmpDir, ev1 } = setupGuardrailsTestDb();

  let capturedPrompt = '';
  const mockLlm = async (messages) => {
    capturedPrompt = messages[1].content;
    return {
      text: JSON.stringify({
        status: 'answered',
        answer: 'PostgreSQL RDS was chosen.',
        claims: [
          {
            text: 'PostgreSQL RDS was chosen',
            receipt_ids: [`event-${ev1.id}`],
            currency: 'current',
          },
        ],
        reasoning_note: null,
      }),
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      model: 'gpt-4.1-mini',
    };
  };

  try {

    const result = await answerQuestion(db, 'What is the database architecture?', mockLlm, {
      maxEvidenceChars: 20,
    });

    assert.equal(result.status, 'answered');
    assert.equal(result.metrics.includedChunkCount, 1, 'First ranked chunk must still be included');
    assert.ok(result.metrics.evidenceCharCount > 20, 'Actual character count should be recorded');
    assert.ok(capturedPrompt.includes('The primary database architecture decision is PostgreSQL on AWS RDS'));
  } finally {
    cleanupGuardrailsTestDb(db, tmpDir);
  }
});

test('3. excluded README and practice files never reach the LLM evidence packet', async () => {
  const { db, tmpDir } = setupGuardrailsTestDb();

  let capturedPrompt = '';
  const mockLlm = async (messages) => {
    capturedPrompt = messages[1].content;
    return {
      text: JSON.stringify({
        status: 'answered',
        answer: 'Direct answer.',
        claims: [],
        reasoning_note: null,
      }),
      usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
      model: 'gpt-4.1-mini',
    };
  };

  try {
    await answerQuestion(db, 'database architecture evaluation benchmark rules', mockLlm);

    assert.ok(!capturedPrompt.includes('00_README.md'));
    assert.ok(!capturedPrompt.includes('PRACTICE-QUESTIONS.md'));
    assert.ok(!capturedPrompt.includes('Internal benchmark rules'));
  } finally {
    cleanupGuardrailsTestDb(db, tmpDir);
  }
});

test('4. answerQuestion writes usage log without storing question, prompt, or source text', async () => {
  const { db, tmpDir, ev1 } = setupGuardrailsTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      status: 'answered',
      answer: 'PostgreSQL RDS is active.',
      claims: [
        {
          text: 'PostgreSQL RDS is active',
          receipt_ids: [`event-${ev1.id}`],
          currency: 'current',
        },
      ],
      reasoning_note: null,
    }),
    usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
    model: 'gpt-4.1-mini',
  });

  try {
    const questionText = 'What is the confidential secret architecture decision?';
    await answerQuestion(db, questionText, mockLlm);

    const logRows = db.prepare('SELECT * FROM llm_usage_log').all();
    assert.equal(logRows.length, 1);

    const log = logRows[0];
    assert.equal(log.operation, 'answer');
    assert.equal(log.model, 'gpt-4.1-mini');
    assert.equal(log.prompt_tokens, 120);
    assert.equal(log.completion_tokens, 45);
    assert.equal(log.total_tokens, 165);
    assert.equal(log.success, 1);
    assert.equal(log.error_category, null);
    assert.ok(log.retrieved_chunk_count > 0);
    assert.ok(log.included_chunk_count > 0);
    assert.ok(log.evidence_char_count > 0);

    const serializedRow = JSON.stringify(log);
    assert.ok(!serializedRow.includes('confidential secret architecture'));
    assert.ok(!serializedRow.includes('Ana Duarte'));
    assert.ok(!serializedRow.includes('PostgreSQL on AWS RDS with WAL'));
  } finally {
    cleanupGuardrailsTestDb(db, tmpDir);
  }
});

test('5. failed answer attempt writes usage row with success = 0 and safe error category', async () => {
  const { db, tmpDir } = setupGuardrailsTestDb();

  const mockTimeoutLlm = async () => {
    throw new Error('LLM request timed out after 60000ms');
  };

  try {
    const result = await answerQuestion(db, 'What is the database architecture?', mockTimeoutLlm);
    assert.equal(result.status, 'insufficient_evidence');

    const logRows = db.prepare('SELECT * FROM llm_usage_log ORDER BY id DESC LIMIT 1').all();
    assert.equal(logRows.length, 1);

    const log = logRows[0];
    assert.equal(log.operation, 'answer');
    assert.equal(log.success, 0);
    assert.equal(log.error_category, 'timeout');
    assert.equal(log.prompt_tokens, 0);
    assert.equal(log.completion_tokens, 0);
    assert.equal(log.total_tokens, 0);
  } finally {
    cleanupGuardrailsTestDb(db, tmpDir);
  }
});

test('6. getUsageSummary and GET /api/usage-summary return correct aggregates', async () => {
  const { db, tmpDir } = setupGuardrailsTestDb();

  logLlmUsage(db, {
    operation: 'answer',
    model: 'gpt-4.1-mini',
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    retrieved_chunk_count: 8,
    included_chunk_count: 5,
    evidence_char_count: 4200,
    success: 1,
  });

  logLlmUsage(db, {
    operation: 'answer',
    model: 'gpt-4.1-mini',
    prompt_tokens: 200,
    completion_tokens: 100,
    total_tokens: 300,
    retrieved_chunk_count: 8,
    included_chunk_count: 6,
    evidence_char_count: 5100,
    success: 1,
  });

  logLlmUsage(db, {
    operation: 'answer',
    model: 'gpt-4.1-mini',
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    retrieved_chunk_count: 8,
    included_chunk_count: 4,
    evidence_char_count: 3500,
    success: 0,
    error_category: 'timeout',
  });

  const summary = getUsageSummary(db);
  assert.equal(summary.answerRequests, 3);
  assert.equal(summary.totalPromptTokens, 300);
  assert.equal(summary.totalCompletionTokens, 150);
  assert.equal(summary.totalTokens, 450);
  assert.equal(summary.averageTokensPerSuccessfulAnswer, 225);
  assert.ok(summary.latestAnswer);
  assert.equal(summary.latestAnswer.retrievedChunkCount, 8);
  assert.equal(summary.latestAnswer.includedChunkCount, 4);
  assert.equal(summary.latestAnswer.evidenceCharCount, 3500);

  const app = createApp(db);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/usage-summary`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.answerRequests, 3);
    assert.equal(body.data.totalTokens, 450);
    assert.equal(body.data.averageTokensPerSuccessfulAnswer, 225);
  } finally {
    server.close();
    cleanupGuardrailsTestDb(db, tmpDir);
  }
});

test('7. answerQuestion returns numeric metrics with finite values even when token counts are 0', async () => {
  const { db, tmpDir, ev1 } = setupGuardrailsTestDb();

  const mockLlmWithZeroTokens = async () => ({
    text: JSON.stringify({
      status: 'answered',
      answer: 'PostgreSQL RDS is active.',
      claims: [
        {
          text: 'PostgreSQL RDS is active',
          receipt_ids: [`event-${ev1.id}`],
          currency: 'current',
        },
      ],
      reasoning_note: null,
    }),
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    model: 'mock-model',
  });

  try {
    const result = await answerQuestion(db, 'What is the database architecture?', mockLlmWithZeroTokens);
    assert.equal(result.status, 'answered');
    assert.ok(result.metrics);
    assert.equal(Number.isFinite(result.metrics.promptTokens), true);
    assert.equal(Number.isFinite(result.metrics.completionTokens), true);
    assert.equal(Number.isFinite(result.metrics.totalTokens), true);
    assert.equal(result.metrics.promptTokens, 0);
    assert.equal(result.metrics.completionTokens, 0);
    assert.equal(result.metrics.totalTokens, 0);
    assert.ok(result.metrics.retrievedChunkCount > 0);
    assert.ok(result.metrics.includedChunkCount > 0);
    assert.ok(result.metrics.evidenceCharCount > 0);
  } finally {
    cleanupGuardrailsTestDb(db, tmpDir);
  }
});
