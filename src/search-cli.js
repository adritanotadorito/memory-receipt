#!/usr/bin/env node

import { initDatabase } from './db.js';
import { searchChunks } from './search.js';

function main() {
  const queryArgs = process.argv.slice(2);
  const query = queryArgs.join(' ').trim();

  if (!query) {
    console.log('Usage: npm run search -- "<query>"');
    console.log('Example: npm run search -- "What was agreed about UAT sign-off?"');
    process.exit(1);
  }

  console.log('===============================================================');
  console.log('  Memory With a Receipt — Evidence Retrieval (FTS5 / BM25)');
  console.log('===============================================================');
  console.log(`Query: "${query}"\n`);

  const db = initDatabase('data/memory.db');

  try {
    const results = searchChunks(db, query, 8);

    if (results.length === 0) {
      console.log('No matching evidence chunks found in the corpus.');
      return;
    }

    console.log(`Found ${results.length} relevant evidence chunk(s):\n`);

    results.forEach((r, idx) => {
      const rank = idx + 1;

      const cleanSnippet = r.snippet
        .replace(/<b>/g, '\x1b[1;33m')
        .replace(/<\/b>/g, '\x1b[0m')
        .replace(/\n+/g, ' ')
        .trim();

      console.log(`---------------------------------------------------------------`);
      console.log(`[Rank ${rank}]  Relevance Score: ${r.relevanceScore.toFixed(4)}  |  Category: ${r.category}`);
      console.log(`File:      ${r.filename}`);
      console.log(`Citation:  ${r.sourceLocation}`);
      console.log(`Snippet:   ${cleanSnippet}`);
    });

    console.log(`---------------------------------------------------------------\n`);
    console.log('===============================================================');
  } catch (err) {
    console.error('Search error:', err);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
