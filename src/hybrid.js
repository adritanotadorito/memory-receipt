import { searchChunks } from './search.js';
import { semanticSearch } from './embeddings.js';

export const RRF_K_CONSTANT = 60;

export async function hybridSearch(db, query, options = {}) {
  const { limit = 8, candidateLimit = 20 } = options;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  const [keywordHits, semanticHits] = await Promise.all([
    Promise.resolve(searchChunks(db, query, candidateLimit)),
    semanticSearch(db, query, candidateLimit),
  ]);

  const chunkMap = new Map();

  keywordHits.forEach((hit, index) => {
    const rank = index + 1;
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

  semanticHits.forEach((hit, index) => {
    const rank = index + 1;
    const rrfContribution = 1 / (RRF_K_CONSTANT + rank);

    if (chunkMap.has(hit.chunkId)) {
      const existing = chunkMap.get(hit.chunkId);
      existing.semanticRank = rank;
      existing.rrfScore += rrfContribution;
      existing.inSemantic = true;
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
