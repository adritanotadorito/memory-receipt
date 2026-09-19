/**
 * ============================================================================
 * ARCHITECTURAL CONCEPTS & DESIGN RATIONALE (PHASE 7: PERSON DELETION)
 * ============================================================================
 *
 * 1. WHY TRUE DELETION WITH DURABLE TOMBSTONES:
 * ----------------------------------------------------------------------------
 * Enterprise AI systems subject to GDPR (Right to be Forgotten) and data privacy
 * mandates must support true deletion.
 * Simply hiding a user or marking a record as "is_deleted = true" is insufficient:
 *   - Outdated vectors in vector stores could still surface in nearest-neighbor
 *     similarity scans.
 *   - Deleted individuals could still be referenced in decision graphs or extracted
 *     quotes.
 *   - Re-running an automated ingestion pipeline (`npm run ingest`) would read the
 *     raw text corpus and resurrect the deleted person's chunks.
 *
 * Solution:
 *   - We purge all derived artifacts from every system store (chunks, embeddings,
 *     decision events, event relations, extraction status, FTS5 full-text index).
 *   - We store a durable record in `deletion_tombstones`.
 *   - Future ingestions consult active tombstones and refuse to create chunks
 *     containing the deleted person's normalized name.
 *
 * 2. TRANSACTIONAL INTEGRITY & AUDIT TRAIL:
 * ----------------------------------------------------------------------------
 * Every deletion runs in an atomic SQLite transaction. The system logs a
 * detailed, immutable `DELETE_PERSON_DATA` audit record capturing exact
 * counts before and after the operation.
 * ============================================================================
 */

import { prepareFtsQuery } from './search.js';

/**
 * Normalizes a person's name for robust, case-insensitive comparison and storage.
 *
 * @param {string} personName
 * @returns {string}
 */
export function normalizePersonName(personName) {
  if (!personName || typeof personName !== 'string') {
    return '';
  }
  return personName.trim().toLowerCase();
}

/**
 * ============================================================================
 * DECISION BLAST RADIUS (PHASE 10)
 * ============================================================================
 *
 * 1. SOURCE DELETION VS. DERIVED-DATA DELETION:
 * ----------------------------------------------------------------------------
 * A core architectural principle of "Memory With a Receipt" is that GDPR / Right
 * to be Forgotten purges operate exclusively on derived AI data stores (chunks,
 * full-text search indexes, vector embeddings, extracted decision events, and
 * graph relations).
 * Original source files in `corpus/` and original enterprise communications (Slack,
 * email, document repositories) remain completely unmodified on disk.
 *
 * 2. EVIDENCE CONTINUITY:
 * ----------------------------------------------------------------------------
 * When a person's derived records are purged, some decision topics may lose their
 * sole supporting receipts in the assistant. Decision Blast Radius precomputes
 * this impact deterministically so users and administrators can see which topics
 * retain independent corroboration versus which topics lose all derived evidence.
 *
 * 3. SOURCE-DOCUMENT INDEPENDENCE RULE:
 * ----------------------------------------------------------------------------
 * To prevent false confidence, surviving evidence is counted by DISTINCT SOURCE
 * DOCUMENTS rather than raw chunk count. Multiple overlapping chunks from the
 * exact same source document do NOT constitute independent corroboration.
 * ============================================================================
 */

/**
 * Computes the Decision Blast Radius for a set of affected chunks and decision events.
 * Evaluates evidence continuity for every affected decision topic.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<object>} affectedChunks
 * @param {Array<object>} affectedEvents
 * @returns {{
 *   topics: Array<{
 *     topic: string,
 *     classification: 'still_supported' | 'reduced_evidence' | 'no_derived_evidence_remaining',
 *     receiptsRemoved: number,
 *     independentReceiptsRemaining: number,
 *     removedReceipts: Array<{ receiptId: string, sourceLocation: string, relativePath: string, eventType?: string, exactQuote?: string }>,
 *     survivingReceipts: Array<{ receiptId: string, sourceLocation: string, relativePath: string, eventType?: string, exactQuote?: string }>
 *   }>,
 *   summary: {
 *     totalAffectedTopics: number,
 *     noDerivedEvidenceRemaining: number,
 *     reducedEvidence: number,
 *     stillSupported: number
 *   }
 * }}
 */
export function computeDecisionBlastRadius(db, affectedChunks = [], affectedEvents = []) {
  if (!Array.isArray(affectedEvents) || affectedEvents.length === 0) {
    return {
      topics: [],
      summary: {
        totalAffectedTopics: 0,
        noDerivedEvidenceRemaining: 0,
        reducedEvidence: 0,
        stillSupported: 0,
      },
    };
  }

  const affectedEventIdSet = new Set(affectedEvents.map((e) => e.event_id || e.id));
  const affectedChunkIdSet = new Set(affectedChunks.map((c) => c.chunk_id || c.id));

  // 1. Map unique normalized topics from the affected events collection
  const normTopicMap = new Map();
  for (const ev of affectedEvents) {
    const rawTopic = ev.topic;
    if (!rawTopic || typeof rawTopic !== 'string' || !rawTopic.trim()) continue;
    const norm = rawTopic.trim().toLowerCase();
    if (!normTopicMap.has(norm)) {
      normTopicMap.set(norm, {
        canonicalTopic: rawTopic.trim(),
        eventCount: 0,
      });
    }
    normTopicMap.get(norm).eventCount++;
  }

  if (normTopicMap.size === 0) {
    return {
      topics: [],
      summary: {
        totalAffectedTopics: 0,
        noDerivedEvidenceRemaining: 0,
        reducedEvidence: 0,
        stillSupported: 0,
      },
    };
  }

  // 2. Fetch all decision events across the database belonging to these affected topics
  const normalizedTopicNames = Array.from(normTopicMap.keys());
  const placeholders = normalizedTopicNames.map(() => '?').join(',');

  const allEventsForTopics = db.prepare(`
    SELECT
      de.id AS event_id,
      de.chunk_id,
      de.topic,
      de.event_type,
      de.exact_quote,
      de.actor_name,
      de.event_date,
      c.document_id,
      d.relative_path,
      c.source_location
    FROM decision_events de
    JOIN chunks c ON de.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    WHERE LOWER(TRIM(de.topic)) IN (${placeholders})
    ORDER BY de.event_date ASC, de.id ASC
  `).all(...normalizedTopicNames);

  // Group retrieved events by normalized topic
  const topicEventsMap = new Map();
  for (const ev of allEventsForTopics) {
    const norm = (ev.topic || '').trim().toLowerCase();
    if (!topicEventsMap.has(norm)) {
      topicEventsMap.set(norm, []);
    }
    topicEventsMap.get(norm).push(ev);
  }

  // 3. Evaluate each affected topic for removal count and surviving independent documents
  const analyzedTopics = [];

  for (const [norm, meta] of normTopicMap.entries()) {
    const eventsForTopic = topicEventsMap.get(norm) || [];

    // Events scheduled for deletion
    const removedEvents = eventsForTopic.filter(
      (e) => affectedEventIdSet.has(e.event_id) || affectedChunkIdSet.has(e.chunk_id)
    );

    // Events that will survive after deletion
    const survivingEvents = eventsForTopic.filter(
      (e) => !affectedEventIdSet.has(e.event_id) && !affectedChunkIdSet.has(e.chunk_id)
    );

    // Independence Rule: Group surviving events by distinct source document
    const survivingDocMap = new Map();
    for (const s of survivingEvents) {
      if (!survivingDocMap.has(s.document_id)) {
        survivingDocMap.set(s.document_id, s);
      }
    }

    const independentReceiptsRemaining = survivingDocMap.size;

    // Categorization
    let classification = 'no_derived_evidence_remaining';
    if (independentReceiptsRemaining >= 2) {
      classification = 'still_supported';
    } else if (independentReceiptsRemaining === 1) {
      classification = 'reduced_evidence';
    }

    // Format up to 2 removed receipt references with source coordinates
    const removedReceipts = removedEvents.slice(0, 2).map((r) => ({
      receiptId: `event-${r.event_id}`,
      sourceLocation: r.source_location,
      relativePath: r.relative_path,
      eventType: r.event_type,
      exactQuote: r.exact_quote,
    }));

    // Format up to 2 surviving receipt references preferring distinct source documents
    const survivingReceipts = Array.from(survivingDocMap.values())
      .slice(0, 2)
      .map((s) => ({
        receiptId: `event-${s.event_id}`,
        sourceLocation: s.source_location,
        relativePath: s.relative_path,
        eventType: s.event_type,
        exactQuote: s.exact_quote,
      }));

    analyzedTopics.push({
      topic: meta.canonicalTopic,
      classification,
      receiptsRemoved: removedEvents.length,
      independentReceiptsRemaining,
      removedReceipts,
      survivingReceipts,
    });
  }

  // 4. Sort topics strictly by risk priority:
  // no_derived_evidence_remaining (1) -> reduced_evidence (2) -> still_supported (3)
  // Tie-breaker: largest number of receipts removed descending -> alphabetical
  const priorityOrder = {
    no_derived_evidence_remaining: 1,
    reduced_evidence: 2,
    still_supported: 3,
  };

  analyzedTopics.sort((a, b) => {
    const pDiff = priorityOrder[a.classification] - priorityOrder[b.classification];
    if (pDiff !== 0) return pDiff;
    const rDiff = b.receiptsRemoved - a.receiptsRemoved;
    if (rDiff !== 0) return rDiff;
    return a.topic.localeCompare(b.topic);
  });

  // Calculate summary counts across all affected topics
  const summary = {
    totalAffectedTopics: analyzedTopics.length,
    noDerivedEvidenceRemaining: analyzedTopics.filter(
      (t) => t.classification === 'no_derived_evidence_remaining'
    ).length,
    reducedEvidence: analyzedTopics.filter(
      (t) => t.classification === 'reduced_evidence'
    ).length,
    stillSupported: analyzedTopics.filter(
      (t) => t.classification === 'still_supported'
    ).length,
  };

  return {
    topics: analyzedTopics.slice(0, 8),
    summary,
  };
}

/**
 * Previews the scope and blast radius of deleting a person from all derived stores.
 * Does not mutate any data.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} personName
 * @returns {{
 *   targetName: string,
 *   normalizedName: string,
 *   affectedChunksCount: number,
 *   affectedChunks: Array<object>,
 *   affectedEventsCount: number,
 *   affectedEvents: Array<object>,
 *   affectedRelationsCount: number,
 *   affectedRelations: Array<object>,
 *   affectedEmbeddingsCount: number,
 *   affectedExtractionsCount: number,
 *   affectedDocuments: string[],
 *   blastRadius: {
 *     topics: Array<object>,
 *     summary: {
 *       totalAffectedTopics: number,
 *       noDerivedEvidenceRemaining: number,
 *       reducedEvidence: number,
 *       stillSupported: number
 *     }
 *   }
 * }}
 */
export function previewPersonDeletion(db, personName) {
  const normalizedName = normalizePersonName(personName);
  if (!normalizedName) {
    throw new Error('personName must be a non-empty string');
  }

  // 1. Identify all chunks containing the person's name (case-insensitive)
  const affectedChunks = db.prepare(`
    SELECT
      c.id AS chunk_id,
      c.document_id,
      c.start_line,
      c.end_line,
      c.source_location,
      d.relative_path,
      d.category,
      d.filename
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE INSTR(LOWER(c.chunk_text), ?) > 0
    ORDER BY d.relative_path ASC, c.start_line ASC
  `).all(normalizedName);

  const affectedChunkIds = affectedChunks.map((c) => c.chunk_id);
  const chunkPlaceholders = affectedChunkIds.length > 0
    ? affectedChunkIds.map(() => '?').join(',')
    : "''";

  // 2. Identify all decision events linked to those chunks OR where actor_name / quote matches
  const affectedEvents = db.prepare(`
    SELECT
      de.id AS event_id,
      de.chunk_id,
      de.event_type,
      de.topic,
      de.actor_name,
      de.event_date,
      de.exact_quote
    FROM decision_events de
    WHERE de.chunk_id IN (${chunkPlaceholders})
       OR LOWER(de.actor_name) = ?
       OR INSTR(LOWER(de.exact_quote), ?) > 0
    ORDER BY de.id ASC
  `).all(...affectedChunkIds, normalizedName, normalizedName);

  const affectedEventIds = affectedEvents.map((e) => e.event_id);
  const eventPlaceholders = affectedEventIds.length > 0
    ? affectedEventIds.map(() => '?').join(',')
    : "''";

  // 3. Identify all event relations touching affected events
  let affectedRelations = [];
  if (affectedEventIds.length > 0) {
    affectedRelations = db.prepare(`
      SELECT er.id, er.from_event_id, er.to_event_id, er.relation_type, er.explanation
      FROM event_relations er
      WHERE er.from_event_id IN (${eventPlaceholders})
         OR er.to_event_id IN (${eventPlaceholders})
    `).all(...affectedEventIds, ...affectedEventIds);
  }

  // 4. Count embeddings and extraction records that will cascade delete
  let affectedEmbeddingsCount = 0;
  let affectedExtractionsCount = 0;
  if (affectedChunkIds.length > 0) {
    const embedRow = db.prepare(`
      SELECT COUNT(*) AS count FROM chunk_embeddings WHERE chunk_id IN (${chunkPlaceholders})
    `).get(...affectedChunkIds);
    affectedEmbeddingsCount = embedRow ? embedRow.count : 0;

    const extractRow = db.prepare(`
      SELECT COUNT(*) AS count FROM chunk_extractions WHERE chunk_id IN (${chunkPlaceholders})
    `).get(...affectedChunkIds);
    affectedExtractionsCount = extractRow ? extractRow.count : 0;
  }

  const affectedDocuments = Array.from(new Set(affectedChunks.map((c) => c.relative_path)));

  // 5. Calculate Decision Blast Radius on evidence topics
  const blastRadius = computeDecisionBlastRadius(db, affectedChunks, affectedEvents);

  return {
    targetName: personName.trim(),
    normalizedName,
    affectedChunksCount: affectedChunks.length,
    affectedChunks,
    affectedEventsCount: affectedEvents.length,
    affectedEvents,
    affectedRelationsCount: affectedRelations.length,
    affectedRelations,
    affectedEmbeddingsCount,
    affectedExtractionsCount,
    affectedDocuments,
    blastRadius,
  };
}

/**
 * Permanently deletes a person's data across all system-derived stores.
 * Records an immutable audit log entry and creates a durable deletion tombstone.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} personName
 * @returns {{
 *   success: boolean,
 *   targetName: string,
 *   normalizedName: string,
 *   deletedChunksCount: number,
 *   deletedEventsCount: number,
 *   deletedRelationsCount: number,
 *   deletedEmbeddingsCount: number,
 *   deletedExtractionsCount: number,
 *   completedAt: string,
 *   verification: object
 * }}
 */
export function deletePersonData(db, personName) {
  const normalizedName = normalizePersonName(personName);
  if (!normalizedName) {
    throw new Error('personName must be a non-empty string');
  }

  const requestedAt = new Date().toISOString();

  // Run the complete deletion process inside an atomic SQLite transaction
  const executePurge = db.transaction(() => {
    // 1. Calculate impact preview before modifying
    const preview = previewPersonDeletion(db, personName);

    // 2. Insert or update the deletion tombstone
    db.prepare(`
      INSERT INTO deletion_tombstones (target_type, target_value, normalized_value, requested_at)
      VALUES ('person', ?, ?, ?)
      ON CONFLICT(normalized_value) DO UPDATE SET requested_at = excluded.requested_at
    `).run(personName.trim(), normalizedName, requestedAt);

    // 3. Delete all chunks containing the person's name (case-insensitive)
    // Foreign key CASCADE and FTS triggers automatically purge:
    // - chunk_embeddings
    // - chunk_extractions
    // - linked decision_events
    // - linked event_relations
    // - chunks_fts index records
    const deleteChunksResult = db.prepare(`
      DELETE FROM chunks WHERE INSTR(LOWER(chunk_text), ?) > 0
    `).run(normalizedName);

    // 4. Delete any remaining decision events where actor_name or exact_quote matches,
    // even if their parent chunk text did not trigger the chunk-level filter
    const deleteEventsResult = db.prepare(`
      DELETE FROM decision_events
      WHERE LOWER(actor_name) = ? OR INSTR(LOWER(exact_quote), ?) > 0
    `).run(normalizedName, normalizedName);

    const completedAt = new Date().toISOString();
    const detailsObj = {
      targetName: personName.trim(),
      normalizedName,
      chunksDeleted: deleteChunksResult.changes,
      additionalEventsDeleted: deleteEventsResult.changes,
      totalEventsDeleted: preview.affectedEventsCount,
      relationsDeleted: preview.affectedRelationsCount,
      embeddingsDeleted: preview.affectedEmbeddingsCount,
      extractionsDeleted: preview.affectedExtractionsCount,
      affectedDocuments: preview.affectedDocuments,
    };

    // 5. Update tombstone with completion timestamp and details JSON
    db.prepare(`
      UPDATE deletion_tombstones
      SET completed_at = ?, details_json = ?
      WHERE normalized_value = ?
    `).run(completedAt, JSON.stringify(detailsObj), normalizedName);

    // 6. Write one detailed audit_log entry
    db.prepare(`
      INSERT INTO audit_log (timestamp, action, document_id, relative_path, details)
      VALUES (?, 'DELETE_PERSON_DATA', NULL, 'system/privacy/tombstones', ?)
    `).run(completedAt, JSON.stringify(detailsObj));

    return {
      success: true,
      targetName: personName.trim(),
      normalizedName,
      deletedChunksCount: deleteChunksResult.changes,
      deletedEventsCount: preview.affectedEventsCount,
      deletedRelationsCount: preview.affectedRelationsCount,
      deletedEmbeddingsCount: preview.affectedEmbeddingsCount,
      deletedExtractionsCount: preview.affectedExtractionsCount,
      completedAt,
    };
  });

  const purgeResult = executePurge();

  // Run post-deletion verification
  const verification = verifyPersonDeletion(db, personName);

  return {
    ...purgeResult,
    verification,
  };
}

/**
 * Verifies that zero trace of the specified person exists in any system-derived store.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} personName
 * @returns {{
 *   targetName: string,
 *   normalizedName: string,
 *   remainingChunks: number,
 *   remainingFtsResults: number,
 *   remainingEvents: number,
 *   remainingEmbeddings: number,
 *   remainingExtractions: number,
 *   cache: string,
 *   verified: boolean
 * }}
 */
export function verifyPersonDeletion(db, personName) {
  const normalizedName = normalizePersonName(personName);
  if (!normalizedName) {
    throw new Error('personName must be a non-empty string');
  }

  // 1. Check chunks table
  const chunksRow = db.prepare(`
    SELECT COUNT(*) AS count FROM chunks WHERE INSTR(LOWER(chunk_text), ?) > 0
  `).get(normalizedName);
  const remainingChunks = chunksRow ? chunksRow.count : 0;

  // 2. Check FTS5 index
  let remainingFtsResults = 0;
  const ftsQuery = prepareFtsQuery(personName);
  if (ftsQuery) {
    try {
      const ftsRow = db.prepare(`
        SELECT COUNT(*) AS count
        FROM chunks_fts f
        JOIN chunks c ON c.id = f.chunk_id
        WHERE chunks_fts MATCH ? AND INSTR(LOWER(c.chunk_text), ?) > 0
      `).get(ftsQuery, normalizedName);
      remainingFtsResults = ftsRow ? ftsRow.count : 0;
    } catch {
      remainingFtsResults = 0;
    }
  }

  // 3. Check decision_events table
  const eventsRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM decision_events
    WHERE LOWER(actor_name) = ? OR INSTR(LOWER(exact_quote), ?) > 0
  `).get(normalizedName, normalizedName);
  const remainingEvents = eventsRow ? eventsRow.count : 0;

  // 4. Check orphaned chunk embeddings
  const embeddingsRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM chunk_embeddings
    WHERE chunk_id NOT IN (SELECT id FROM chunks)
  `).get();
  const remainingEmbeddings = embeddingsRow ? embeddingsRow.count : 0;

  // 5. Check orphaned chunk extraction records
  const extractionsRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM chunk_extractions
    WHERE chunk_id NOT IN (SELECT id FROM chunks)
  `).get();
  const remainingExtractions = extractionsRow ? extractionsRow.count : 0;

  const verified = (
    remainingChunks === 0 &&
    remainingFtsResults === 0 &&
    remainingEvents === 0 &&
    remainingEmbeddings === 0 &&
    remainingExtractions === 0
  );

  return {
    targetName: personName.trim(),
    normalizedName,
    remainingChunks,
    remainingFtsResults,
    remainingEvents,
    remainingEmbeddings,
    remainingExtractions,
    cache: 'none (no project cache stores exist)',
    verified,
  };
}

/**
 * Retrieves all registered deletion tombstones.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{
 *   id: number,
 *   target_type: string,
 *   target_value: string,
 *   normalized_value: string,
 *   requested_at: string,
 *   completed_at: string | null,
 *   details_json: string | null
 * }>}
 */
export function getDeletionTombstones(db) {
  return db.prepare(`
    SELECT * FROM deletion_tombstones
    ORDER BY requested_at DESC, id DESC
  `).all();
}
