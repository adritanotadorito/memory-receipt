/**
 * ============================================================================
 * ARCHITECTURAL CONCEPTS & DESIGN RATIONALE (BEGINNER GUIDE)
 * ============================================================================
 *
 * 1. WHAT ARE EMBEDDINGS?
 * ----------------------------------------------------------------------------
 * An embedding is a mathematical translation of human text into a dense vector
 * (a fixed-size list of floating-point numbers, e.g., 384 numbers).
 * Unlike simple keyword search that looks for exact character matches,
 * embedding models place semantically similar concepts close together in
 * high-dimensional geometry.
 * For example, "staff tracking identifier" and "operator ID" will produce
 * vectors that point in nearly the same mathematical direction, even though they
 * share zero keywords.
 *
 * 2. WHY NORMALIZED VECTORS MAKE COSINE SIMILARITY WORK:
 * ----------------------------------------------------------------------------
 * Cosine similarity measures the angle $\theta$ between two vectors $\vec{u}$ and $\vec{v}$:
 *   $\text{Cosine Similarity} = \frac{\vec{u} \cdot \vec{v}}{\|\vec{u}\| \|\vec{v}\|}$
 *
 * Calculating vector magnitudes ($\|\vec{u}\| = \sqrt{\sum u_i^2}$) during every
 * query across thousands of stored chunks is computationally expensive.
 * However, by normalizing every embedding vector to unit length ($\|\vec{u}\| = 1$)
 * at the moment it is generated:
 *   $\text{Cosine Similarity} = \frac{\vec{u} \cdot \vec{v}}{1 \times 1} = \vec{u} \cdot \vec{v} = \sum_{i=1}^n u_i v_i$
 * The cosine similarity simplifies into a single, blazing-fast dot product!
 *
 * 3. IDENTICAL EMBEDDING PIPELINE FOR CHUNKS AND QUERIES:
 * ----------------------------------------------------------------------------
 * To ensure consistent geometric comparison, chunk texts and user search
 * queries MUST pass through the exact same tokenization, transformer model,
 * mean-pooling strategy, and L2-normalization step.
 * ============================================================================
 */

export const DEFAULT_MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

// Process-level singleton cache for the embedding model pipeline
let pipelineInstance = null;
let pipelinePromise = null;

/**
 * Loads the local transformer embedding model once per process (singleton).
 *
 * @param {string} [modelName=DEFAULT_MODEL_NAME]
 * @returns {Promise<Function>}
 */
export async function getEmbeddingPipeline(modelName = DEFAULT_MODEL_NAME) {
  if (pipelineInstance) {
    return pipelineInstance;
  }

  if (pipelinePromise) {
    return pipelinePromise;
  }

  pipelinePromise = (async () => {
    const { pipeline } = await import('@xenova/transformers');
    const extractor = await pipeline('feature-extraction', modelName, {
      quantized: true,
    });

    pipelineInstance = extractor;
    return extractor;
  })();

  return pipelinePromise;
}

/**
 * Generates an L2-normalized embedding vector for a given text.
 *
 * @param {string} text - Input text
 * @param {string} [modelName=DEFAULT_MODEL_NAME]
 * @returns {Promise<number[]>} Array of floating point numbers
 */
export async function generateEmbedding(text, modelName = DEFAULT_MODEL_NAME) {
  const extractor = await getEmbeddingPipeline(modelName);
  const cleanText = text.replace(/\s+/g, ' ').trim();

  // Run feature extraction with mean pooling and L2 normalization
  const output = await extractor(cleanText, {
    pooling: 'mean',
    normalize: true,
  });

  return Array.from(output.data);
}

/**
 * Computes the dot product (cosine similarity for normalized vectors) between two vectors.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Value in range [-1.0, 1.0]
 */
export function dotProduct(a, b) {
  let dot = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Finds all chunks in the database lacking embeddings and generates them locally.
 * Idempotent: Skips chunks that already have embeddings.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {number} [options.batchSize=32]
 * @param {string} [options.modelName=DEFAULT_MODEL_NAME]
 * @param {Function} [options.onProgress]
 * @returns {Promise<{
 *   totalChunks: number,
 *   newEmbeddedCount: number,
 *   skippedCount: number,
 *   modelName: string
 * }>}
 */
export async function embedCorpusChunks(db, options = {}) {
  const {
    batchSize = 32,
    modelName = DEFAULT_MODEL_NAME,
    onProgress = null,
  } = options;

  // Find chunks without embeddings
  const missingChunks = db.prepare(`
    SELECT c.id, c.chunk_text
    FROM chunks c
    LEFT JOIN chunk_embeddings e ON c.id = e.chunk_id
    WHERE e.chunk_id IS NULL
    ORDER BY c.id ASC
  `).all();

  const totalChunksRow = db.prepare('SELECT COUNT(*) as count FROM chunks').get();
  const totalChunks = totalChunksRow.count;
  const skippedCount = totalChunks - missingChunks.length;

  if (missingChunks.length === 0) {
    return {
      totalChunks,
      newEmbeddedCount: 0,
      skippedCount,
      modelName,
    };
  }

  // Pre-load embedding model once before processing loop
  const extractor = await getEmbeddingPipeline(modelName);

  const insertStmt = db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, model_name, embedding_json, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO NOTHING
  `);

  let newEmbeddedCount = 0;
  const now = () => new Date().toISOString();

  // Process missing chunks in manageable batches
  for (let i = 0; i < missingChunks.length; i += batchSize) {
    const batch = missingChunks.slice(i, i + batchSize);
    const timestamp = now();

    const embeddings = await Promise.all(
      batch.map(async (item) => {
        const cleanText = item.chunk_text.replace(/\s+/g, ' ').trim();
        const output = await extractor(cleanText, {
          pooling: 'mean',
          normalize: true,
        });
        return {
          chunkId: item.id,
          vector: Array.from(output.data),
        };
      })
    );

    // Save batch atomically
    const transaction = db.transaction(() => {
      for (const item of embeddings) {
        insertStmt.run(
          item.chunkId,
          modelName,
          JSON.stringify(item.vector),
          timestamp
        );
      }
    });

    transaction();
    newEmbeddedCount += batch.length;

    if (typeof onProgress === 'function') {
      onProgress(newEmbeddedCount, missingChunks.length, totalChunks);
    }
  }

  return {
    totalChunks,
    newEmbeddedCount,
    skippedCount,
    modelName,
  };
}

/**
 * Performs semantic similarity search against stored chunk embeddings.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} query - User search question
 * @param {number} [limit=8] - Number of top chunks to return
 * @param {string} [modelName=DEFAULT_MODEL_NAME]
 * @returns {Promise<Array<{
 *   chunkId: string,
 *   documentId: string,
 *   relativePath: string,
 *   filename: string,
 *   category: string,
 *   sourceLocation: string,
 *   exactSourceText: string,
 *   snippet: string,
 *   similarityScore: number
 * }>>}
 */
export async function semanticSearch(db, query, limit = 8, modelName = DEFAULT_MODEL_NAME) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  // 1. Generate normalized query embedding vector
  const queryVector = await generateEmbedding(query, modelName);

  // 2. Fetch all stored embeddings joined with chunks and documents
  const rows = db.prepare(`
    SELECT
      c.id AS chunk_id,
      c.document_id,
      d.relative_path,
      d.filename,
      d.category,
      c.source_location,
      c.chunk_text,
      e.embedding_json
    FROM chunk_embeddings e
    JOIN chunks c ON c.id = e.chunk_id
    JOIN documents d ON d.id = c.document_id
  `).all();

  if (rows.length === 0) {
    return [];
  }

  // 3. Score every chunk using fast dot product (cosine similarity)
  const scored = rows.map((row) => {
    const chunkVector = JSON.parse(row.embedding_json);
    const similarity = dotProduct(queryVector, chunkVector);
    const cleanSnippet = row.chunk_text.replace(/\s+/g, ' ').slice(0, 160) + '...';

    return {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      relativePath: row.relative_path,
      filename: row.filename,
      category: row.category,
      sourceLocation: row.source_location,
      exactSourceText: row.chunk_text,
      snippet: cleanSnippet,
      similarityScore: parseFloat(similarity.toFixed(4)),
    };
  });

  // 4. Sort descending by similarity score and take top limit
  scored.sort((a, b) => b.similarityScore - a.similarityScore);
  return scored.slice(0, limit);
}
