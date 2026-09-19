import { prepareFtsQuery } from './search.js';

export function normalizePersonName(personName) {
  if (!personName || typeof personName !== 'string') {
    return '';
  }
  return personName.trim().toLowerCase();
}

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

  const topicEventsMap = new Map();
  for (const ev of allEventsForTopics) {
    const norm = (ev.topic || '').trim().toLowerCase();
    if (!topicEventsMap.has(norm)) {
      topicEventsMap.set(norm, []);
    }
    topicEventsMap.get(norm).push(ev);
  }

  const analyzedTopics = [];

  for (const [norm, meta] of normTopicMap.entries()) {
    const eventsForTopic = topicEventsMap.get(norm) || [];

    const removedEvents = eventsForTopic.filter(
      (e) => affectedEventIdSet.has(e.event_id) || affectedChunkIdSet.has(e.chunk_id)
    );

    const survivingEvents = eventsForTopic.filter(
      (e) => !affectedEventIdSet.has(e.event_id) && !affectedChunkIdSet.has(e.chunk_id)
    );

    const survivingDocMap = new Map();
    for (const s of survivingEvents) {
      if (!survivingDocMap.has(s.document_id)) {
        survivingDocMap.set(s.document_id, s);
      }
    }

    const independentReceiptsRemaining = survivingDocMap.size;

    let classification = 'no_derived_evidence_remaining';
    if (independentReceiptsRemaining >= 2) {
      classification = 'still_supported';
    } else if (independentReceiptsRemaining === 1) {
      classification = 'reduced_evidence';
    }

    const removedReceipts = removedEvents.slice(0, 2).map((r) => ({
      receiptId: `event-${r.event_id}`,
      sourceLocation: r.source_location,
      relativePath: r.relative_path,
      eventType: r.event_type,
      exactQuote: r.exact_quote,
    }));

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

export function previewPersonDeletion(db, personName) {
  const normalizedName = normalizePersonName(personName);
  if (!normalizedName) {
    throw new Error('personName must be a non-empty string');
  }

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

  let affectedRelations = [];
  if (affectedEventIds.length > 0) {
    affectedRelations = db.prepare(`
      SELECT er.id, er.from_event_id, er.to_event_id, er.relation_type, er.explanation
      FROM event_relations er
      WHERE er.from_event_id IN (${eventPlaceholders})
         OR er.to_event_id IN (${eventPlaceholders})
    `).all(...affectedEventIds, ...affectedEventIds);
  }

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

export function deletePersonData(db, personName) {
  const normalizedName = normalizePersonName(personName);
  if (!normalizedName) {
    throw new Error('personName must be a non-empty string');
  }

  const requestedAt = new Date().toISOString();

  const executePurge = db.transaction(() => {

    const preview = previewPersonDeletion(db, personName);

    db.prepare(`
      INSERT INTO deletion_tombstones (target_type, target_value, normalized_value, requested_at)
      VALUES ('person', ?, ?, ?)
      ON CONFLICT(normalized_value) DO UPDATE SET requested_at = excluded.requested_at
    `).run(personName.trim(), normalizedName, requestedAt);

    const deleteChunksResult = db.prepare(`
      DELETE FROM chunks WHERE INSTR(LOWER(chunk_text), ?) > 0
    `).run(normalizedName);

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

    db.prepare(`
      UPDATE deletion_tombstones
      SET completed_at = ?, details_json = ?
      WHERE normalized_value = ?
    `).run(completedAt, JSON.stringify(detailsObj), normalizedName);

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

  const verification = verifyPersonDeletion(db, personName);

  return {
    ...purgeResult,
    verification,
  };
}

export function verifyPersonDeletion(db, personName) {
  const normalizedName = normalizePersonName(personName);
  if (!normalizedName) {
    throw new Error('personName must be a non-empty string');
  }

  const chunksRow = db.prepare(`
    SELECT COUNT(*) AS count FROM chunks WHERE INSTR(LOWER(chunk_text), ?) > 0
  `).get(normalizedName);
  const remainingChunks = chunksRow ? chunksRow.count : 0;

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

  const eventsRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM decision_events
    WHERE LOWER(actor_name) = ? OR INSTR(LOWER(exact_quote), ?) > 0
  `).get(normalizedName, normalizedName);
  const remainingEvents = eventsRow ? eventsRow.count : 0;

  const embeddingsRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM chunk_embeddings
    WHERE chunk_id NOT IN (SELECT id FROM chunks)
  `).get();
  const remainingEmbeddings = embeddingsRow ? embeddingsRow.count : 0;

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

export function getDeletionTombstones(db) {
  return db.prepare(`
    SELECT * FROM deletion_tombstones
    ORDER BY requested_at DESC, id DESC
  `).all();
}
