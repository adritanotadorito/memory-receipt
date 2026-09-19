/**
 * Decision ledger management: creates and queries grounded decision events and relations.
 * Event quotes are validated against chunk text, and downstream events cascade-delete with chunks.
 */

export const VALID_EVENT_TYPES = new Set([
  'proposal',
  'commitment',
  'reversal',
  'rejection',
  'status_claim',
  'issue',
  'action',
]);

export const VALID_VERIFICATION_STATUSES = new Set([
  'candidate',
  'supported',
  'superseded',
  'contradicted',
  'insufficient_evidence',
]);

export const VALID_RELATION_TYPES = new Set([
  'supports',
  'supersedes',
  'contradicts',
  'follows_up_on',
  'lacks_follow_up',
]);

/**
 * Creates a new decision event grounded in an existing chunk.
 * Validates that the exact quote is literally present in the source chunk text.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} event
 * @param {string} event.chunk_id - Or chunkId
 * @param {string} event.event_type - Or eventType
 * @param {string} event.topic
 * @param {string} [event.value]
 * @param {string} [event.actor_name] - Or actorName
 * @param {string} [event.actor_organization] - Or actorOrganization
 * @param {string} [event.event_date] - Or eventDate
 * @param {string} event.exact_quote - Or exactQuote
 * @param {number} event.confidence
 * @param {string} event.verification_status - Or verificationStatus
 * @param {string} [event.created_at] - Or createdAt
 * @returns {object} The created decision event with generated ID
 */
export function createDecisionEvent(db, event) {
  if (!event || typeof event !== 'object') {
    throw new Error('Event data must be a valid object');
  }

  const chunkId = event.chunk_id ?? event.chunkId;
  const eventType = event.event_type ?? event.eventType;
  const topic = event.topic;
  const value = event.value ?? null;
  const actorName = event.actor_name ?? event.actorName ?? null;
  const actorOrg = event.actor_organization ?? event.actorOrganization ?? null;
  const eventDate = event.event_date ?? event.eventDate ?? null;
  const exactQuote = event.exact_quote ?? event.exactQuote;
  const confidence = event.confidence;
  const verificationStatus = event.verification_status ?? event.verificationStatus;
  const createdAt = event.created_at ?? event.createdAt ?? new Date().toISOString();

  if (chunkId === undefined || chunkId === null || (typeof chunkId === 'string' && chunkId.trim().length === 0)) {
    throw new Error('chunk_id must be provided as a non-empty string or integer');
  }

  if (!eventType || !VALID_EVENT_TYPES.has(eventType)) {
    throw new Error(`Invalid event_type: "${eventType}". Must be one of: ${Array.from(VALID_EVENT_TYPES).join(', ')}`);
  }

  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    throw new Error('topic must be a non-empty string');
  }

  if (typeof exactQuote !== 'string' || exactQuote.trim().length === 0) {
    throw new Error('exact_quote must be a non-empty string');
  }

  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0.0 || confidence > 1.0) {
    throw new Error(`confidence must be a number between 0.0 and 1.0. Received: ${confidence}`);
  }

  if (!verificationStatus || !VALID_VERIFICATION_STATUSES.has(verificationStatus)) {
    throw new Error(`Invalid verification_status: "${verificationStatus}". Must be one of: ${Array.from(VALID_VERIFICATION_STATUSES).join(', ')}`);
  }

  // Verify literal quote containment in referenced chunk
  const chunk = db.prepare(`
    SELECT c.id, c.chunk_text, c.document_id, d.relative_path
    FROM chunks c
    LEFT JOIN documents d ON c.document_id = d.id
    WHERE c.id = ?
  `).get(chunkId);

  if (!chunk) {
    throw new Error(`Referenced chunk_id "${chunkId}" does not exist in the database`);
  }

  if (!chunk.chunk_text.includes(exactQuote)) {
    throw new Error(`Grounding validation failed: exact_quote is not literally contained in chunk "${chunkId}"`);
  }

  const insertStmt = db.prepare(`
    INSERT INTO decision_events (
      chunk_id, event_type, topic, value, actor_name, actor_organization,
      event_date, exact_quote, confidence, verification_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insertStmt.run(
    chunkId,
    eventType,
    topic.trim(),
    value,
    actorName,
    actorOrg,
    eventDate,
    exactQuote,
    confidence,
    verificationStatus,
    createdAt
  );

  const eventId = Number(result.lastInsertRowid);

  db.prepare(`
    INSERT INTO audit_log (timestamp, action, document_id, relative_path, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    createdAt,
    'CREATE_DECISION_EVENT',
    chunk.document_id || null,
    chunk.relative_path || '',
    JSON.stringify({
      event_id: eventId,
      chunk_id: chunkId,
      event_type: eventType,
      topic: topic.trim(),
      verification_status: verificationStatus,
    })
  );

  return {
    id: eventId,
    chunk_id: chunkId,
    event_type: eventType,
    topic: topic.trim(),
    value,
    actor_name: actorName,
    actor_organization: actorOrg,
    event_date: eventDate,
    exact_quote: exactQuote,
    confidence,
    verification_status: verificationStatus,
    created_at: createdAt,
  };
}

/**
 * Creates a relationship edge between two existing decision events.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} relation
 * @param {number} relation.from_event_id - Or fromEventId
 * @param {number} relation.to_event_id - Or toEventId
 * @param {string} relation.relation_type - Or relationType
 * @param {string} [relation.explanation]
 * @param {string} [relation.created_at] - Or createdAt
 * @returns {object} The created relation record with generated ID
 */
export function createEventRelation(db, relation) {
  if (!relation || typeof relation !== 'object') {
    throw new Error('Relation data must be a valid object');
  }

  const fromEventId = relation.from_event_id ?? relation.fromEventId;
  const toEventId = relation.to_event_id ?? relation.toEventId;
  const relationType = relation.relation_type ?? relation.relationType;
  const explanation = relation.explanation ?? null;
  const createdAt = relation.created_at ?? relation.createdAt ?? new Date().toISOString();

  if (!fromEventId || typeof fromEventId !== 'number') {
    throw new Error('from_event_id must be a valid numeric ID');
  }

  if (!toEventId || typeof toEventId !== 'number') {
    throw new Error('to_event_id must be a valid numeric ID');
  }

  if (!relationType || !VALID_RELATION_TYPES.has(relationType)) {
    throw new Error(`Invalid relation_type: "${relationType}". Must be one of: ${Array.from(VALID_RELATION_TYPES).join(', ')}`);
  }

  // Verify both event endpoints exist in decision_events
  const fromEvent = db.prepare('SELECT id, topic FROM decision_events WHERE id = ?').get(fromEventId);
  if (!fromEvent) {
    throw new Error(`Source decision event with id ${fromEventId} does not exist`);
  }

  const toEvent = db.prepare('SELECT id, topic FROM decision_events WHERE id = ?').get(toEventId);
  if (!toEvent) {
    throw new Error(`Target decision event with id ${toEventId} does not exist`);
  }

  const insertStmt = db.prepare(`
    INSERT INTO event_relations (from_event_id, to_event_id, relation_type, explanation, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = insertStmt.run(fromEventId, toEventId, relationType, explanation, createdAt);
  const relationId = Number(result.lastInsertRowid);

  db.prepare(`
    INSERT INTO audit_log (timestamp, action, document_id, relative_path, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    createdAt,
    'CREATE_EVENT_RELATION',
    null,
    'ledger/relations',
    JSON.stringify({
      relation_id: relationId,
      from_event_id: fromEventId,
      to_event_id: toEventId,
      relation_type: relationType,
    })
  );

  return {
    id: relationId,
    from_event_id: fromEventId,
    to_event_id: toEventId,
    relation_type: relationType,
    explanation,
    created_at: createdAt,
  };
}

/**
 * Retrieves all decision events associated with a specific topic, ordered chronologically.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} topic
 * @returns {Array<object>}
 */
export function getEventsForTopic(db, topic) {
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    throw new Error('Topic must be a non-empty string');
  }

  const stmt = db.prepare(`
    SELECT
      de.*,
      c.source_location,
      c.start_line,
      c.end_line,
      d.relative_path,
      d.filename
    FROM decision_events de
    LEFT JOIN chunks c ON de.chunk_id = c.id
    LEFT JOIN documents d ON c.document_id = d.id
    WHERE de.topic = ?
    ORDER BY de.event_date ASC, de.id ASC
  `);

  return stmt.all(topic.trim());
}

/**
 * Retrieves the local event graph for a topic: all topic events and all relation edges
 * connecting them.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} topic
 * @returns {{ topic: string, events: Array<object>, relations: Array<object> }}
 */
export function getLocalEventGraph(db, topic) {
  const events = getEventsForTopic(db, topic);

  if (events.length === 0) {
    return {
      topic: topic.trim(),
      events: [],
      relations: [],
    };
  }

  const eventIds = events.map((e) => e.id);
  const placeholders = eventIds.map(() => '?').join(',');

  const relationsStmt = db.prepare(`
    SELECT
      er.*,
      fe.topic as from_topic,
      te.topic as to_topic
    FROM event_relations er
    JOIN decision_events fe ON er.from_event_id = fe.id
    JOIN decision_events te ON er.to_event_id = te.id
    WHERE er.from_event_id IN (${placeholders}) OR er.to_event_id IN (${placeholders})
    ORDER BY er.id ASC
  `);

  const relations = relationsStmt.all(...eventIds, ...eventIds);

  return {
    topic: topic.trim(),
    events,
    relations,
  };
}

/**
 * Deletes a decision event by ID and records an audit log entry.
 * Connected relations are automatically deleted via ON DELETE CASCADE.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} eventId
 * @returns {{ deleted: boolean, changes: number }}
 */
export function deleteDecisionEvent(db, eventId) {
  if (!eventId || typeof eventId !== 'number') {
    throw new Error('eventId must be a valid numeric ID');
  }

  const event = db.prepare(`
    SELECT de.*, c.document_id, d.relative_path
    FROM decision_events de
    LEFT JOIN chunks c ON de.chunk_id = c.id
    LEFT JOIN documents d ON c.document_id = d.id
    WHERE de.id = ?
  `).get(eventId);

  if (!event) {
    return { deleted: false, changes: 0 };
  }

  const result = db.prepare('DELETE FROM decision_events WHERE id = ?').run(eventId);

  db.prepare(`
    INSERT INTO audit_log (timestamp, action, document_id, relative_path, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    'DELETE_DECISION_EVENT',
    event.document_id || null,
    event.relative_path || 'ledger',
    JSON.stringify({
      event_id: eventId,
      topic: event.topic,
      event_type: event.event_type,
    })
  );

  return {
    deleted: result.changes > 0,
    changes: result.changes,
  };
}
