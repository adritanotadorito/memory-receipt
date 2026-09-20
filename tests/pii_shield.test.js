import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDatabase } from '../src/db.js';
import { createPiiShieldContext, redactPii } from '../src/pii-shield.js';
import { answerQuestion } from '../src/answer.js';
import { createDecisionEvent } from '../src/ledger.js';

function setupPiiTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES ('doc_contact', 'emails/01_contact.txt', '01_contact.txt', 'email', '2024-01-01', 'h_contact', 30)
  `).run();

  const rawChunkText = `From: Alice Smith <alice.smith@acme.corp>
To: Bob Jones <bob.jones@partner.org>
Date: 2024-03-15
Phone: +1 (555) 123-4567 or direct dial 555-0199
Support: +44 20 7946 0958

Please contact Alice at alice.smith@acme.corp if the ERP cutover on lines 1-30 encounters blockers.
Decision: Phase 2 go-live is confirmed for June 1st.`;

  db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES ('doc_contact_c0001', 'doc_contact', 0, ?, 1, 10, 'emails/01_contact.txt, lines 1-10', '2024-01-01')
  `).run(rawChunkText);

  const event = createDecisionEvent(db, {
    chunk_id: 'doc_contact_c0001',
    event_type: 'commitment',
    topic: 'ERP cutover go-live',
    value: 'confirmed for June 1st',
    actor_name: 'Alice Smith',
    actor_organization: 'Acme Corp',
    event_date: '2024-03-15',
    exact_quote: 'Phase 2 go-live is confirmed for June 1st.',
    confidence: 0.95,
    verification_status: 'supported',
  });

  return { db, rawChunkText, eventId: event.id };
}

test('1. email addresses are consistently replaced with stable [EMAIL_n] placeholders', () => {
  const context = createPiiShieldContext();
  const input = 'Contact alice@example.com or bob@partner.org. Later, follow up with alice@example.com.';
  const result = redactPii(input, context);

  assert.equal(result.text, 'Contact [EMAIL_1] or [EMAIL_2]. Later, follow up with [EMAIL_1].');
  assert.equal(result.emailsRedacted, 3);
  assert.equal(result.phonesRedacted, 0);
  assert.equal(result.totalDirectIdentifiersRedacted, 3);
});

test('2. phone numbers (domestic & international) are consistently replaced with stable [PHONE_n] placeholders', () => {
  const context = createPiiShieldContext();
  const input = 'Call +1 (555) 123-4567, UK +44 20 7946 0958, local 555-0199, or +1-555-123-4567 again.';
  const result = redactPii(input, context);

  assert.equal(result.text, 'Call [PHONE_1], UK [PHONE_2], local [PHONE_3], or [PHONE_1] again.');
  assert.equal(result.phonesRedacted, 4);
  assert.equal(result.emailsRedacted, 0);
  assert.equal(result.totalDirectIdentifiersRedacted, 4);
});

test('3. dates, line ranges, times, and entity IDs are not falsely redacted as phone numbers', () => {
  const context = createPiiShieldContext();
  const input = 'On 2024-03-15 at 14:30, check event-123 in doc_01 lines 1-30 with 100% confidence.';
  const result = redactPii(input, context);

  assert.equal(result.text, input);
  assert.equal(result.phonesRedacted, 0);
  assert.equal(result.emailsRedacted, 0);
  assert.equal(result.totalDirectIdentifiersRedacted, 0);
});

test('4. original local chunks in SQLite remain byte-for-byte untouched', async () => {
  const { db, rawChunkText } = setupPiiTestDb();

  const capturedPrompts = [];
  const mockLlm = async (messages) => {
    capturedPrompts.push(messages);
    return {
      text: JSON.stringify({
        status: 'answered',
        answer: 'Phase 2 go-live is confirmed for June 1st.',
        claims: [{
          text: 'Phase 2 go-live is confirmed for June 1st.',
          receipt_ids: ['event-1'],
          currency: 'current',
        }],
        reasoning_note: null,
      }),
      usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
    };
  };

  const answerResult = await answerQuestion(
    db,
    'What did alice.smith@acme.corp say about ERP cutover? Call +1 (555) 123-4567.',
    mockLlm
  );

  const chunkRow = db.prepare('SELECT chunk_text FROM chunks WHERE id = ?').get('doc_contact_c0001');
  assert.equal(chunkRow.chunk_text, rawChunkText);
  assert.equal(answerResult.status, 'answered');
});

test('5. complete serialized outbound OpenAI messages contain no raw email or phone numbers', async () => {
  const { db } = setupPiiTestDb();

  let outboundMessages = null;
  const mockLlm = async (messages) => {
    outboundMessages = messages;
    return {
      text: JSON.stringify({
        status: 'answered',
        answer: 'Phase 2 go-live is confirmed for June 1st.',
        claims: [{
          text: 'Phase 2 go-live is confirmed for June 1st.',
          receipt_ids: ['event-1'],
          currency: 'current',
        }],
        reasoning_note: null,
      }),
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    };
  };

  const userQuery = 'Did alice.smith@acme.corp confirm cutover? Phone is +1 (555) 123-4567';
  const res = await answerQuestion(db, userQuery, mockLlm);

  assert.ok(outboundMessages);
  const serializedOutbound = JSON.stringify(outboundMessages);

  assert.ok(!serializedOutbound.includes('alice.smith@acme.corp'));
  assert.ok(!serializedOutbound.includes('bob.jones@partner.org'));
  assert.ok(!serializedOutbound.includes('+1 (555) 123-4567'));
  assert.ok(!serializedOutbound.includes('555-0199'));
  assert.ok(!serializedOutbound.includes('+44 20 7946 0958'));

  assert.ok(serializedOutbound.includes('[EMAIL_1]'));
  assert.ok(serializedOutbound.includes('[PHONE_1]'));

  assert.equal(res.metrics.emailsRedacted >= 2, true);
  assert.equal(res.metrics.phonesRedacted >= 2, true);
  assert.equal(res.metrics.totalDirectIdentifiersRedacted, res.metrics.emailsRedacted + res.metrics.phonesRedacted);
});

test('6. literal receipt/citation validation still uses original local evidence from SQLite', async () => {
  const { db } = setupPiiTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      status: 'answered',
      answer: 'Phase 2 go-live is confirmed for June 1st.',
      claims: [{
        text: 'Phase 2 go-live is confirmed for June 1st.',
        receipt_ids: ['event-1'],
        currency: 'current',
      }],
      reasoning_note: null,
    }),
    usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
  });

  const res = await answerQuestion(db, 'When is Phase 2 go-live?', mockLlm);

  assert.equal(res.status, 'answered');
  assert.equal(res.claims.length, 1);
  assert.equal(res.claims[0].evidence_quote, 'Phase 2 go-live is confirmed for June 1st.');
  assert.equal(res.citations.length, 1);
  assert.equal(res.citations[0].actorName, 'Alice Smith');
  assert.equal(res.citations[0].sourceLocation, 'emails/01_contact.txt, lines 1-10');
});

test('7. answer response never exposes or leaks internal emailMap or phoneMap', async () => {
  const { db } = setupPiiTestDb();

  const mockLlm = async () => ({
    text: JSON.stringify({
      status: 'answered',
      answer: 'Phase 2 go-live is confirmed for June 1st.',
      claims: [{
        text: 'Phase 2 go-live is confirmed for June 1st.',
        receipt_ids: ['event-1'],
        currency: 'current',
      }],
      reasoning_note: null,
    }),
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  });

  const res = await answerQuestion(db, 'Email me at test@example.com or call 555-123-4567', mockLlm);

  assert.equal(res.emailMap, undefined);
  assert.equal(res.phoneMap, undefined);
  assert.equal(res.metrics.emailMap, undefined);
  assert.equal(res.metrics.phoneMap, undefined);

  assert.equal(typeof res.metrics.emailsRedacted, 'number');
  assert.equal(typeof res.metrics.phonesRedacted, 'number');
  assert.equal(typeof res.metrics.totalDirectIdentifiersRedacted, 'number');
});
