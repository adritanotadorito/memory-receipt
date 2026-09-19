#!/usr/bin/env node

import { initDatabase } from './db.js';
import { hybridSearch } from './hybrid.js';

/**
 * CLI runner for hybrid search command.
 * Invoked via: npm run hybrid-search -- "What was agreed about UAT sign-off?"
 */
async function main() {
  const queryArgs = process.argv.slice(2);
  const query = queryArgs.join(' ').trim();

  if (!query) {
    console.log('Usage: npm run hybrid-search -- "<query>"');
    console.log('Example: npm run hybrid-search -- "What was agreed about UAT sign-off?"');
    process.exit(1);
  }

  console.log('===============================================================');
  console.log('  Memory With a Receipt — Hybrid Retrieval (BM25 + Semantic RRF)');
  console.log('===============================================================');
  console.log(`Query: "${query}"\n`);

  const db = initDatabase('data/memory.db');

  try {
    const results = await hybridSearch(db, query, { limit: 8 });

    if (results.length === 0) {
      console.log('No matching evidence chunks found.');
      return;
    }

    console.log(`Found ${results.length} ranked hybrid evidence chunk(s):\n`);

    results.forEach((r, idx) => {
      const rank = idx + 1;
      let sourceTag = r.retrievalSource.toUpperCase();
      if (r.retrievalSource === 'both') {
        sourceTag = '\x1b[1;32mBOTH (Keyword # ' + r.keywordRank + ' + Semantic # ' + r.semanticRank + ')\x1b[0m';
      } else if (r.retrievalSource === 'keyword') {
        sourceTag = '\x1b[1;34mKEYWORD ONLY (Rank #' + r.keywordRank + ')\x1b[0m';
      } else {
        sourceTag = '\x1b[1;35mSEMANTIC ONLY (Rank #' + r.semanticRank + ')\x1b[0m';
      }

      const cleanSnippet = r.snippet
        .replace(/<b>/g, '\x1b[1;33m')
        .replace(/<\/b>/g, '\x1b[0m')
        .replace(/\s+/g, ' ')
        .trim();

      console.log(`---------------------------------------------------------------`);
      console.log(`[Rank ${rank}]  Hybrid RRF Score: ${r.hybridScore.toFixed(6)}  |  Source: ${sourceTag}`);
      console.log(`File:      ${r.filename} (${r.category})`);
      console.log(`Citation:  ${r.sourceLocation}`);
      console.log(`Snippet:   ${cleanSnippet}`);
    });

    console.log(`---------------------------------------------------------------\n`);
    console.log('===============================================================');
  } catch (err) {
    console.error('Hybrid search error:', err);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
