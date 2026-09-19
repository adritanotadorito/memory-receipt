import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * ============================================================================
 * ARCHITECTURAL CONCEPTS & DESIGN RATIONALE (BEGINNER GUIDE)
 * ============================================================================
 *
 * 1. WHY DOCUMENTS BECOME CHUNKS:
 * ----------------------------------------------------------------------------
 * Real-world enterprise documents (e.g., an 800-line meeting transcript or a
 * lengthy email thread) contain dozens of distinct discussions, decisions, and
 * facts scattered across time.
 * If we treated an entire document as a single atomic unit of memory:
 *   - Search and retrieval would be coarse and noisy.
 *   - Feeding entire 50,000-word archives into an LLM context window is
 *     expensive, slow, and degrades reasoning quality ("needle in a haystack").
 * By breaking documents into smaller, overlapping chunks (e.g., 30 lines with
 * 10 lines overlap), each chunk represents a focused conversational turn or
 * topic snippet. This allows precise semantic matching and targeted retrieval
 * without losing surrounding context.
 *
 * 2. WHY CHUNKS PRESERVE EXACT LINE RANGES:
 * ----------------------------------------------------------------------------
 * "Memory With a Receipt" means every AI claim must be 100% auditable and
 * citeable back to the ground-truth evidence.
 * By recording exact start and end line numbers (e.g., "lines 12-28") alongside
 * the exact relative file path:
 *   - Citations become verifiable receipts that a human auditor or automated
 *     grader can immediately look up in the original file.
 *   - We prevent hallucinations and fabricated claims because every piece of
 *     retrieved knowledge carries its physical coordinates in the corpus.
 *   - We never alter, reorder, or lose characters from the original text.
 *
 * 3. WHY PRACTICE QUESTIONS (AND README) ARE EXCLUDED FROM INGESTION:
 * ----------------------------------------------------------------------------
 * Practice questions (`PRACTICE-QUESTIONS.md`) and project overviews (`00_README.md`)
 * are meta-specifications and evaluation queries for the hackathon challenge,
 * NOT part of the corporate archive / domain reality of Acme Org.
 * If we ingested practice questions into the memory database:
 *   - We would contaminate the knowledge base with the evaluation benchmark itself
 *     (data leakage).
 *   - An AI system could inadvertently retrieve questions rather than the actual
 *     underlying evidence documents (emails, meeting notes, reports).
 *   - To ensure pure, unbiased grounding, only authentic operational records
 *     under `emails/`, `reports/`, and `transcripts/` are ingested.
 * ============================================================================
 */

// Target subdirectories to ingest within the corpus
const TARGET_SUBDIRS = ['emails', 'reports', 'transcripts'];

// Files explicitly excluded from ingestion
const EXCLUDED_FILENAMES = new Set(['00_README.md', 'PRACTICE-QUESTIONS.md']);

// Chunking configuration
const CHUNK_SIZE_LINES = 30;
const CHUNK_OVERLAP_LINES = 10;

/**
 * Computes a SHA-256 hexadecimal hash for a string or buffer.
 *
 * @param {string|Buffer} content
 * @returns {string}
 */
export function computeHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Generates a stable, deterministic ID for a document based on its relative path.
 *
 * @param {string} relativePath
 * @returns {string}
 */
export function generateDocId(relativePath) {
  return `doc_${computeHash(relativePath).slice(0, 16)}`;
}

/**
 * Generates a stable, deterministic ID for a chunk.
 *
 * @param {string} docId
 * @param {number} chunkIndex
 * @returns {string}
 */
export function generateChunkId(docId, chunkIndex) {
  return `${docId}_c${String(chunkIndex).padStart(4, '0')}`;
}

/**
 * Determines the category of a document based on its relative directory path.
 *
 * @param {string} relativePath
 * @returns {'email' | 'report' | 'transcript' | null}
 */
export function categorizeDocument(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.includes('/emails/') || normalized.startsWith('emails/')) return 'email';
  if (normalized.includes('/reports/') || normalized.startsWith('reports/')) return 'report';
  if (normalized.includes('/transcripts/') || normalized.startsWith('transcripts/')) return 'transcript';
  return null;
}

/**
 * Splits document content into overlapping line-based chunks.
 * Faithfully preserves exact original lines, line indices, and ordering.
 *
 * @param {string} rawContent - The entire raw file content.
 * @param {string} relativePath - Normalized relative path of the file.
 * @param {string} docId - Stable document identifier.
 * @param {number} [chunkSize=30] - Number of lines per chunk.
 * @param {number} [overlap=10] - Number of overlapping lines between adjacent chunks.
 * @returns {Array<{
 *   id: string,
 *   documentId: string,
 *   chunkIndex: number,
 *   chunkText: string,
 *   startLine: number,
 *   endLine: number,
 *   sourceLocation: string
 * }>}
 */
export function createLineBasedChunks(
  rawContent,
  relativePath,
  docId,
  chunkSize = CHUNK_SIZE_LINES,
  overlap = CHUNK_OVERLAP_LINES
) {
  // Normalize newline characters while keeping line content strictly untouched
  const lines = rawContent.split(/\r?\n/);
  const totalLines = lines.length;
  const chunks = [];

  if (totalLines === 0) {
    return chunks;
  }

  const step = Math.max(1, chunkSize - overlap);
  let chunkIndex = 0;

  for (let i = 0; i < totalLines; i += step) {
    const startLine = i + 1; // 1-indexed start line
    const endLine = Math.min(i + chunkSize, totalLines); // 1-indexed end line

    // Extract exact lines for this chunk without any modification
    const chunkLines = lines.slice(i, endLine);
    const chunkText = chunkLines.join('\n');

    // Required format: "relative/path/to/file.txt, lines 12-28"
    const sourceLocation = `${relativePath}, lines ${startLine}-${endLine}`;

    chunks.push({
      id: generateChunkId(docId, chunkIndex),
      documentId: docId,
      chunkIndex,
      chunkText,
      startLine,
      endLine,
      sourceLocation,
    });

    chunkIndex++;

    // If we've reached or covered the end of the file, stop sliding
    if (endLine >= totalLines) {
      break;
    }
  }

  return chunks;
}

/**
 * Recursively scans the corpus directory and identifies candidate .txt files and excluded files.
 *
 * @param {string} corpusDir - Root path of the corpus (e.g., 'corpus/acme').
 * @returns {{
 *   validFiles: Array<{ fullPath: string, relativePath: string, filename: string, category: string }>,
 *   excludedFiles: string[]
 * }}
 */
export function scanCorpus(corpusDir = 'corpus/acme') {
  const validFiles = [];
  const excludedFiles = [];

  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();

        // Check if the file is inside one of the target subdirectories
        const category = categorizeDocument(relativePath);

        if (ext === '.txt' && category !== null) {
          validFiles.push({
            fullPath,
            relativePath,
            filename: entry.name,
            category,
          });
        } else {
          excludedFiles.push(relativePath);
        }
      }
    }
  }

  walk(corpusDir);

  // Sort deterministically by relative path
  validFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  excludedFiles.sort((a, b) => a.localeCompare(b));

  return { validFiles, excludedFiles };
}

/**
 * Ingests the corpus into SQLite idempotently with reliable citations and audit logging.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [corpusDir='corpus/acme']
 * @returns {{
 *   indexedByCategory: Record<string, number>,
 *   totalIndexedDocs: number,
 *   totalChunks: number,
 *   newDocsCount: number,
 *   updatedDocsCount: number,
 *   skippedDocsCount: number,
 *   excludedFiles: string[],
 *   errors: Array<{ file: string, error: string }>
 * }}
 */
export function ingestCorpus(db, corpusDir = 'corpus/acme') {
  const { validFiles, excludedFiles } = scanCorpus(corpusDir);

  const errors = [];
  let newDocsCount = 0;
  let updatedDocsCount = 0;
  let skippedDocsCount = 0;

  // Load active completed deletion tombstones for persons
  let tombstoneNames = [];
  try {
    const tombstoneRows = db.prepare(`
      SELECT normalized_value FROM deletion_tombstones
      WHERE target_type = 'person' AND completed_at IS NOT NULL
    `).all();
    tombstoneNames = tombstoneRows.map((r) => r.normalized_value);
  } catch {
    // Table may not exist yet in legacy or mock databases
  }

  // Prepared SQL statements for high performance and atomicity
  const selectDocStmt = db.prepare('SELECT id, content_hash FROM documents WHERE relative_path = ?');
  const insertDocStmt = db.prepare(`
    INSERT INTO documents (id, relative_path, filename, category, imported_at, content_hash, total_lines)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateDocStmt = db.prepare(`
    UPDATE documents
    SET imported_at = ?, content_hash = ?, total_lines = ?
    WHERE id = ?
  `);
  const deleteChunksStmt = db.prepare('DELETE FROM chunks WHERE document_id = ?');
  const insertChunkStmt = db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, chunk_text, start_line, end_line, source_location, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAuditStmt = db.prepare(`
    INSERT INTO audit_log (timestamp, action, document_id, relative_path, details)
    VALUES (?, ?, ?, ?, ?)
  `);

  const now = () => new Date().toISOString();

  // Process each document within an atomic transaction per file
  for (const file of validFiles) {
    try {
      const rawContent = fs.readFileSync(file.fullPath, 'utf-8');
      const lines = rawContent.split(/\r?\n/);
      const contentHash = computeHash(rawContent);
      const docId = generateDocId(file.relativePath);
      const existing = selectDocStmt.get(file.relativePath);

      if (existing && existing.content_hash === contentHash) {
        // Document has not changed — skip to maintain idempotency
        skippedDocsCount++;
        continue;
      }

      const allChunks = createLineBasedChunks(rawContent, file.relativePath, docId);
      // Filter out chunks containing tombstoned person names
      const chunks = tombstoneNames.length > 0
        ? allChunks.filter((chunk) => {
          const textLower = chunk.chunkText.toLowerCase();
          return !tombstoneNames.some((tName) => textLower.includes(tName));
        })
        : allChunks;

      const timestamp = now();

      const transaction = db.transaction(() => {
        if (!existing) {
          // New document insertion
          insertDocStmt.run(
            docId,
            file.relativePath,
            file.filename,
            file.category,
            timestamp,
            contentHash,
            lines.length
          );

          for (const chunk of chunks) {
            insertChunkStmt.run(
              chunk.id,
              chunk.documentId,
              chunk.chunkIndex,
              chunk.chunkText,
              chunk.startLine,
              chunk.endLine,
              chunk.sourceLocation,
              timestamp
            );
          }

          insertAuditStmt.run(
            timestamp,
            'INGEST',
            docId,
            file.relativePath,
            JSON.stringify({ chunksCreated: chunks.length, totalLines: lines.length, category: file.category })
          );

          newDocsCount++;
        } else {
          // Document modified — replace old chunks with new ones
          deleteChunksStmt.run(docId);
          updateDocStmt.run(timestamp, contentHash, lines.length, docId);

          for (const chunk of chunks) {
            insertChunkStmt.run(
              chunk.id,
              chunk.documentId,
              chunk.chunkIndex,
              chunk.chunkText,
              chunk.startLine,
              chunk.endLine,
              chunk.sourceLocation,
              timestamp
            );
          }

          insertAuditStmt.run(
            timestamp,
            'UPDATE',
            docId,
            file.relativePath,
            JSON.stringify({ chunksReplaced: chunks.length, totalLines: lines.length, category: file.category })
          );

          updatedDocsCount++;
        }
      });

      transaction();
    } catch (err) {
      errors.push({
        file: file.relativePath,
        error: err.message || String(err),
      });
    }
  }

  // Gather final database statistics
  const categoryCountsRaw = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM documents
    GROUP BY category
  `).all();

  const indexedByCategory = {
    email: 0,
    report: 0,
    transcript: 0,
  };
  for (const row of categoryCountsRaw) {
    indexedByCategory[row.category] = row.count;
  }

  const totalChunksRow = db.prepare('SELECT COUNT(*) as count FROM chunks').get();
  const totalIndexedDocsRow = db.prepare('SELECT COUNT(*) as count FROM documents').get();

  return {
    indexedByCategory,
    totalIndexedDocs: totalIndexedDocsRow.count,
    totalChunks: totalChunksRow.count,
    newDocsCount,
    updatedDocsCount,
    skippedDocsCount,
    excludedFiles,
    errors,
  };
}
