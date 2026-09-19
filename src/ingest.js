import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TARGET_SUBDIRS = ['emails', 'reports', 'transcripts'];

const EXCLUDED_FILENAMES = new Set(['00_README.md', 'PRACTICE-QUESTIONS.md']);

const CHUNK_SIZE_LINES = 30;
const CHUNK_OVERLAP_LINES = 10;

export function computeHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function generateDocId(relativePath) {
  return `doc_${computeHash(relativePath).slice(0, 16)}`;
}

export function generateChunkId(docId, chunkIndex) {
  return `${docId}_c${String(chunkIndex).padStart(4, '0')}`;
}

export function categorizeDocument(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.includes('/emails/') || normalized.startsWith('emails/')) return 'email';
  if (normalized.includes('/reports/') || normalized.startsWith('reports/')) return 'report';
  if (normalized.includes('/transcripts/') || normalized.startsWith('transcripts/')) return 'transcript';
  return null;
}

export function createLineBasedChunks(
  rawContent,
  relativePath,
  docId,
  chunkSize = CHUNK_SIZE_LINES,
  overlap = CHUNK_OVERLAP_LINES
) {

  const lines = rawContent.split(/\r?\n/);
  const totalLines = lines.length;
  const chunks = [];

  if (totalLines === 0) {
    return chunks;
  }

  const step = Math.max(1, chunkSize - overlap);
  let chunkIndex = 0;

  for (let i = 0; i < totalLines; i += step) {
    const startLine = i + 1;
    const endLine = Math.min(i + chunkSize, totalLines);

    const chunkLines = lines.slice(i, endLine);
    const chunkText = chunkLines.join('\n');

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

    if (endLine >= totalLines) {
      break;
    }
  }

  return chunks;
}

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

  validFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  excludedFiles.sort((a, b) => a.localeCompare(b));

  return { validFiles, excludedFiles };
}

export function ingestCorpus(db, corpusDir = 'corpus/acme') {
  const { validFiles, excludedFiles } = scanCorpus(corpusDir);

  const errors = [];
  let newDocsCount = 0;
  let updatedDocsCount = 0;
  let skippedDocsCount = 0;

  let tombstoneNames = [];
  try {
    const tombstoneRows = db.prepare(`
      SELECT normalized_value FROM deletion_tombstones
      WHERE target_type = 'person' AND completed_at IS NOT NULL
    `).all();
    tombstoneNames = tombstoneRows.map((r) => r.normalized_value);
  } catch {

  }

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

  for (const file of validFiles) {
    try {
      const rawContent = fs.readFileSync(file.fullPath, 'utf-8');
      const lines = rawContent.split(/\r?\n/);
      const contentHash = computeHash(rawContent);
      const docId = generateDocId(file.relativePath);
      const existing = selectDocStmt.get(file.relativePath);

      if (existing && existing.content_hash === contentHash) {

        skippedDocsCount++;
        continue;
      }

      const allChunks = createLineBasedChunks(rawContent, file.relativePath, docId);

      const chunks = tombstoneNames.length > 0
        ? allChunks.filter((chunk) => {
          const textLower = chunk.chunkText.toLowerCase();
          return !tombstoneNames.some((tName) => textLower.includes(tName));
        })
        : allChunks;

      const timestamp = now();

      const transaction = db.transaction(() => {
        if (!existing) {

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
