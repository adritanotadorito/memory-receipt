import { searchChunks } from './search.js';
import { semanticSearch } from './embeddings.js';

/**
 * ============================================================================
 * HYBRID RETRIEVAL & RECIPROCAL RANK FUSION (RRF)
 * ============================================================================
 *
 * Why Hybrid Retrieval?
 * - Keyword search (BM25) excels at precise terminology, proper nouns, dates,
 *   and specific codes (e.g., "OP_ID", "15_uat-signoff", "2024-03-20").
 * - Semantic search (Cosine Similarity) excels at conceptual paraphrases,
 *   synonyms, and intent when exact vocabulary doesn't match.
 *
 * How Reciprocal Rank Fusion (RRF) Works:
 * - Scores from BM25 (relevance score) and Vector search (cosine similarity)
 *   operate on completely different scales. Directly averaging them produces
 *   unbalanced, skewed results.
 * - RRF normalizes rank positions rather than raw scores:
 *     $RRF(d) = \sum_{m \in \{\text{keyword}, \text{semantic}\}} \frac{1}{k + \text{rank}_m(d)}$
 *   where $k = 60$ is the standard smoothing constant.
 * - Chunks retrieved near the top of both methods receive an additive boost.
 * ============================================================================
 */

export const RRF_K_CONSTANT = 60;

/**
 * Performs hybrid retrieval combining FTS5 keyword search and vector semantic search.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} query - User natural language query
 * @param {object} [options]
 * @param {number} [options.limit=8] - Number of fused chunks to return
 * @param {number} [options.candidateLimit=20] - Candidates per method before fusion
 * @returns {Promise<Array<{
 *   chunkId: string,
 *   documentId: string,
 *   relativePath: string,
 *   filename: string,
 *   category: string,
 *   sourceLocation: string,
 *   exactSourceText: string,
 *   snippet: string,
 *   hybridScore: number,
 *   retrievalSource: 'keyword' | 'semantic' | 'both',
 *   keywordRank: number | null,
 *   semanticRank: number | null
 * }>>}
 */
export async function hybridSearch(db, query, options = {}) {
  const { limit = 8, candidateLimit = 20 } = options;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  // 1. Run both searches in parallel
  const [keywordHits, semanticHits] = await Promise.all([
    Promise.resolve(searchChunks(db, query, candidateLimit)),
    semanticSearch(db, query, candidateLimit),
  ]);

  // 2. Aggregate candidate chunks using Reciprocal Rank Fusion (RRF)
  const chunkMap = new Map();

  // Process Keyword hits
  keywordHits.forEach((hit, index) => {
    const rank = index + 1; // 1-indexed rank
    const rrfContribution = 1 / (RRF_K_CONSTANT + rank);

    chunkMap.set(hit.chunkId, {
      ...hit,
      keywordRank: rank,
      semanticRank: null,
      rrfScore: rrfContribution,
      inKeyword: true,
      inSemantic: false,
    });
  });

  // Process Semantic hits
  semanticHits.forEach((hit, index) => {
    const rank = index + 1; // 1-indexed rank
    const rrfContribution = 1 / (RRF_K_CONSTANT + rank);

    if (chunkMap.has(hit.chunkId)) {
      const existing = chunkMap.get(hit.chunkId);
      existing.semanticRank = rank;
      existing.rrfScore += rrfContribution;
      existing.inSemantic = true;
      // Prefer the FTS highlighted snippet if available
      if (!existing.snippet && hit.snippet) {
        existing.snippet = hit.snippet;
      }
    } else {
      chunkMap.set(hit.chunkId, {
        ...hit,
        keywordRank: null,
        semanticRank: rank,
        rrfScore: rrfContribution,
        inKeyword: false,
        inSemantic: true,
      });
    }
  });

  // 3. Convert to array and format metadata
  const candidates = Array.from(chunkMap.values());

  candidates.sort((a, b) => b.rrfScore - a.rrfScore);

  return candidates.slice(0, limit).map((c) => {
    let retrievalSource;
    if (c.inKeyword && c.inSemantic) {
      retrievalSource = 'both';
    } else if (c.inKeyword) {
      retrievalSource = 'keyword';
    } else {
      retrievalSource = 'semantic';
    }

    return {
      chunkId: c.chunkId,
      documentId: c.documentId,
      relativePath: c.relativePath,
      filename: c.filename,
      category: c.category,
      sourceLocation: c.sourceLocation,
      exactSourceText: c.exactSourceText,
      snippet: c.snippet,
      hybridScore: parseFloat(c.rrfScore.toFixed(6)),
      retrievalSource,
      keywordRank: c.keywordRank,
      semanticRank: c.semanticRank,
    };
  });
}
