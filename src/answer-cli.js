#!/usr/bin/env node
import { initDatabase } from './db.js';
import { answerQuestion } from './answer.js';

/**
 * CLI script to query the Memory With a Receipt evidence-grounded answer engine.
 *
 * Usage:
 *   node --env-file=.env src/answer-cli.js "What is the current decision on bakery scope?"
 *   npm run ask -- "What is the current decision on bakery scope?"
 */
async function main() {
  const args = process.argv.slice(2);
  const question = args.join(' ').trim();

  if (!question) {
    console.error('\n❌ Please provide a question to answer.');
    console.error('Usage: npm run ask -- "<your question>"\n');
    process.exit(1);
  }

  const dbPath = process.env.DB_PATH || 'data/memory.db';
  const db = initDatabase(dbPath);

  console.log('\n================================================================');
  console.log('         MEMORY WITH A RECEIPT: EVIDENCE ANSWER ENGINE');
  console.log('================================================================');
  console.log(`Question:  "${question}"`);
  console.log(`Database:  ${dbPath}`);
  console.log(`Model:     ${process.env.OPENAI_MODEL || 'gpt-4.1-mini'}`);
  console.log('----------------------------------------------------------------\n');

  try {
    const result = await answerQuestion(db, question);

    // 1. Status badge
    let statusLabel = 'UNKNOWN';
    if (result.status === 'answered') statusLabel = '✅ ANSWERED (HIGH CONFIDENCE)';
    else if (result.status === 'conflicting_evidence') statusLabel = '⚠️  CONFLICTING EVIDENCE DETECTED';
    else if (result.status === 'insufficient_evidence') statusLabel = '❓ INSUFFICIENT EVIDENCE IN CORPUS';

    console.log(`Status:  ${statusLabel}\n`);

    // 2. Plain-English Grounded Answer
    console.log('--- Grounded Answer ---');
    console.log(result.answer);
    console.log('');

    // 3. Reasoning / Conflict Note (if present)
    if (result.reasoningNote) {
      console.log('--- Discrepancy / Uncertainty Note ---');
      console.log(`⚠️  ${result.reasoningNote}\n`);
    }

    // 4. Atomic Claims with currency, citation numbers, and exact supporting receipt quotes
    if (result.claims && result.claims.length > 0) {
      console.log('--- Verified Atomic Claims ---');
      result.claims.forEach((claim, i) => {
        // Map receipt IDs to citation numbers
        const citationNumbers = (claim.receipt_ids || claim.evidence_ids || []).map((rid) => {
          const matched = result.citations.find((c) => c.receiptId === rid);
          return matched ? `[${matched.citationNumber}]` : `[${rid}]`;
        }).join(' ');

        const currencyTag = `[${claim.currency.toUpperCase()}]`.padEnd(14);
        console.log(`  ${i + 1}. ${currencyTag} ${claim.text} ${citationNumbers}`);

        // Display each supporting verified receipt quote and source location
        if (claim.receipts && claim.receipts.length > 0) {
          claim.receipts.forEach((r) => {
            console.log(`     • Verified Receipt [${r.receiptId}]: ${r.sourceLocation} (${r.category})`);
            console.log(`       Quote: "${r.exactQuote}"`);
          });
        } else if (claim.evidence_quote) {
          console.log(`     Quote: "${claim.evidence_quote}"`);
        }
      });
      console.log('');
    }

    // 5. Numbered Verified Physical Citations
    if (result.citations && result.citations.length > 0) {
      console.log('--- Verified Receipts (Physical Citations) ---');
      result.citations.forEach((cit) => {
        const actor = cit.actorName ? ` | Actor: ${cit.actorName}` : '';
        const date = cit.eventDate ? ` | Date: ${cit.eventDate}` : '';
        console.log(`  [${cit.citationNumber}] ${cit.receiptId}: ${cit.sourceLocation} (${cit.category})`);
        console.log(`      [${cit.eventType.toUpperCase()}] Topic: "${cit.topic}"${actor}${date}`);
        console.log(`      Quote: "${cit.exactQuote}"`);
      });
      console.log('');
    }

    // 6. Linked Decision Ledger Events
    if (result.events && result.events.length > 0) {
      console.log('--- Linked Decision Ledger Events ---');
      result.events.slice(0, 5).forEach((ev) => {
        const actor = ev.actor_name ? ` (${ev.actor_name})` : '';
        const date = ev.event_date ? ` [${ev.event_date}]` : '';
        console.log(`  • [${ev.event_type.toUpperCase()}] ${ev.topic}${actor}${date}: "${ev.exact_quote}"`);
      });
      console.log('');
    }

    console.log('================================================================\n');
  } catch (err) {
    console.error(`\n❌ Error generating answer: ${err.message}\n`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
