/**
 * Keyword search over SQLite FTS5 using BM25 ranking.
 * Attaches exact source citations and highlighted snippets to retrieved chunks.
 */

// High-frequency grammatical stop words to filter out for cleaner query token weighting
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'did', 'do', 'does', 'doing', 'for', 'from', 'had', 'has', 'have', 'having',
  'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'is',
  'it', 'its', 'me', 'my', 'no', 'nor', 'not', 'of', 'on', 'or', 'our',
  'ours', 'she', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'whom', 'why', 'with', 'would', 'you', 'your', 'yours'
]);

/**
 * Sanitizes and formats a natural language user query for SQLite FTS5 MATCH syntax.
 * Extracts meaningful keyword tokens, strips special FTS characters, and builds a
 * balanced query supporting exact tokens and prefix matches.
 *
 * @param {string} userQuery
 * @returns {string} Safe FTS5 MATCH expression
 */
export function prepareFtsQuery(userQuery) {
  if (!userQuery || typeof userQuery !== 'string') {
    return '';
  }

  const rawTokens = userQuery
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (rawTokens.length === 0) {
    return '';
  }

  const significantTokens = rawTokens.filter((t) => !STOP_WORDS.has(t));
  const queryTokens = significantTokens.length > 0 ? significantTokens : rawTokens;

  // Build FTS5 expression with prefix matching for terms of length >= 3
  const ftsClauses = [];

  for (const token of queryTokens) {
    const safeToken = token.replace(/"/g, '""');
    if (safeToken.length >= 3) {
      ftsClauses.push(`"${safeToken}"*`);
    } else {
      ftsClauses.push(`"${safeToken}"`);
    }
  }

  return ftsClauses.join(' OR ');
}

/**
 * Searches the SQLite FTS5 index for relevant document chunks.
 *
 * @param {import('better-sqlite3').Database} db - SQLite database instance
 * @param {string} query - Natural language search query
 * @param {number} [limit=8] - Maximum number of chunks to return (default 8)
 * @returns {Array<{
 *   chunkId: string,
 *   documentId: string,
 *   relativePath: string,
 *   filename: string,
 *   category: string,
 *   sourceLocation: string,
 *   exactSourceText: string,
 *   snippet: string,
 *   relevanceScore: number
 * }>}
 */
export function searchChunks(db, query, limit = 8) {
  const ftsQuery = prepareFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }

  try {
    const stmt = db.prepare(`
      SELECT
        c.id AS chunk_id,
        c.document_id,
        d.relative_path,
        d.filename,
        d.category,
        c.source_location,
        c.chunk_text,
        snippet(chunks_fts, 1, '<b>', '</b>', '...', 25) AS highlighted_snippet,
        bm25(chunks_fts) AS bm25_rank
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH ?
      ORDER BY bm25_rank ASC
      LIMIT ?
    `);

    const rows = stmt.all(ftsQuery, limit);

    return rows.map((row) => {
      // In SQLite FTS5 bm25(), more negative scores mean stronger relevance.
      // We convert this to a positive relevance score for intuitive readability.
      const relevanceScore = parseFloat(Math.abs(row.bm25_rank).toFixed(4));

      return {
        chunkId: row.chunk_id,
        documentId: row.document_id,
        relativePath: row.relative_path,
        filename: row.filename,
        category: row.category,
        sourceLocation: row.source_location,
        exactSourceText: row.chunk_text,
        snippet: row.highlighted_snippet || row.chunk_text.slice(0, 150) + '...',
        relevanceScore,
      };
    });
  } catch (err) {
    console.error('FTS Search Query Error:', err.message);
    return [];
  }
}
