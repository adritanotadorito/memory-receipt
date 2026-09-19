#!/usr/bin/env node
import { initDatabase } from './db.js';

/**
 * CLI script to display summary statistics of the Decision Ledger.
 */
function main() {
  const dbPath = process.env.DB_PATH || 'data/memory.db';
  const db = initDatabase(dbPath);

  try {
    const totalEventsResult = db.prepare('SELECT COUNT(*) as count FROM decision_events').get();
    const totalRelationsResult = db.prepare('SELECT COUNT(*) as count FROM event_relations').get();

    const eventsByType = db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM decision_events
      GROUP BY event_type
      ORDER BY count DESC, event_type ASC
    `).all();

    const eventsByStatus = db.prepare(`
      SELECT verification_status, COUNT(*) as count
      FROM decision_events
      GROUP BY verification_status
      ORDER BY count DESC, verification_status ASC
    `).all();

    const eventsByTopic = db.prepare(`
      SELECT topic, COUNT(*) as count
      FROM decision_events
      GROUP BY topic
      ORDER BY count DESC, topic ASC
      LIMIT 10
    `).all();

    console.log('\n========================================');
    console.log('       DECISION LEDGER STATUS');
    console.log('========================================');
    console.log(`Database Path:   ${dbPath}`);
    console.log(`Total Events:    ${totalEventsResult.count}`);
    console.log(`Total Relations: ${totalRelationsResult.count}`);
    console.log('----------------------------------------');

    console.log('\n--- Events by Type ---');
    if (eventsByType.length === 0) {
      console.log('  (no events recorded yet)');
    } else {
      eventsByType.forEach((row) => {
        console.log(`  • ${row.event_type.padEnd(16)} : ${row.count}`);
      });
    }

    console.log('\n--- Events by Verification Status ---');
    if (eventsByStatus.length === 0) {
      console.log('  (no events recorded yet)');
    } else {
      eventsByStatus.forEach((row) => {
        console.log(`  • ${row.verification_status.padEnd(22)} : ${row.count}`);
      });
    }

    if (eventsByTopic.length > 0) {
      console.log('\n--- Top Topics ---');
      eventsByTopic.forEach((row) => {
        console.log(`  • ${row.topic.padEnd(30)} : ${row.count}`);
      });
    }

    console.log('\n========================================\n');
  } finally {
    db.close();
  }
}

main();
