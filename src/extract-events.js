import { chatCompletion } from './llm.js';
import { createDecisionEvent, VALID_EVENT_TYPES } from './ledger.js';

export const EXTRACTOR_VERSION = 'v1.1';

/**
 * Strict JSON Schema definition for OpenAI Structured Outputs.
 */
export const EXTRACTION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'decision_events_extraction',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          description: 'List of explicit decision-relevant events found in the chunk',
          items: {
            type: 'object',
            properties: {
              event_type: {
                type: 'string',
                enum: [
                  'proposal',
                  'commitment',
                  'reversal',
                  'rejection',
                  'status_claim',
                  'issue',
                  'action',
                ],
                description: 'The category of decision event',
              },
              topic: {
                type: 'string',
                description: 'Short neutral topic label directly grounded in the quote (e.g. "bakery scope", "shelf-life field mapping")',
              },
              value: {
                type: ['string', 'null'],
                description: 'Key metric, parameter, scope designation, or outcome value if stated, or null',
              },
              actor_name: {
                type: ['string', 'null'],
                description: 'Person or speaker name explicitly associated with the statement, or null',
              },
              actor_organization: {
                type: ['string', 'null'],
                description: 'Organization, team, or department if explicitly mentioned, or null',
              },
              event_date: {
                type: ['string', 'null'],
                description: 'Date or timestamp explicitly mentioned in text, or null',
              },
              exact_quote: {
                type: 'string',
                description: 'Verbatim character-for-character quote from the text snippet',
              },
              confidence: {
                type: 'number',
                description: 'Confidence score between 0.0 and 1.0',
              },
            },
            required: [
              'event_type',
              'topic',
              'value',
              'actor_name',
              'actor_organization',
              'event_date',
              'exact_quote',
              'confidence',
            ],
            additionalProperties: false,
          },
        },
      },
      required: ['events'],
      additionalProperties: false,
    },
  },
};

/**
 * System prompt instructing the LLM to extract decision-relevant events.
 */
export const SYSTEM_PROMPT = `You are an evidence-first decision extraction engine for enterprise memory.
Your job is to extract explicit, verifiable decision-relevant events from the provided text snippet.

What counts as a decision-relevant event:
- Scope inclusions or exclusions (e.g., quote "Bakery Bakery is out of scope." -> event_type: "status_claim" or "commitment", topic: "bakery scope", value: "out of scope").
- Agreed commitments, sign-offs, go-live dates, and deadlines (e.g., "Monday is fresh golive").
- Technical proposals, architectural suggestions, or field mapping plans.
- Reversals, rollbacks, or cancellations of previous decisions.
- Rejections or refusals of requests or proposals.
- Status claims, verified operational milestones, or progress reports.
- Assigned operational tasks, action items, or owners.
- Reported blockers, risks, bugs, or discrepancies.

Note: You do NOT need formal words like "decided" or "approved". Any clear statement of scope, commitment, status, proposal, issue, or action counts!

STRICT EXTRACTION RULES:
1. Extract ONLY what is directly, explicitly stated in this text snippet.
2. "exact_quote" MUST be copied character-for-character, verbatim from the snippet. Do NOT alter words, punctuation, or capitalization.
3. "topic" MUST be a short neutral label grounded in the quote (e.g., "bakery scope", "shelf-life field mapping", "cutover schedule").
4. Do NOT infer or invent missing actors, organizations, or dates. Set them to null when not explicitly stated in the text.
5. "confidence" must be a float between 0.0 and 1.0.
6. If there are no qualifying decision events in the text, return {"events": []}.`;

/**
 * Safely parses JSON string output from the LLM, handling structured output root objects
 * and markdown code fences if present.
 *
 * @param {string} rawText
 * @returns {Array<object>}
 */
export function parseModelJson(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return [];
  }

  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.events)) return parsed.events;
      if (Array.isArray(parsed.decision_events)) return parsed.decision_events;
      if (Array.isArray(parsed.data)) return parsed.data;
    }
    return [];
  } catch {
    // Attempt regex extraction for JSON object or array if surrounded by text
    const objectMatch = cleaned.match(/\{[\s\S]*"events"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
    if (objectMatch) {
      try {
        const obj = JSON.parse(objectMatch[0]);
        if (Array.isArray(obj.events)) return obj.events;
      } catch {}
    }

    const arrayMatch = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch {}
    }
    return [];
  }
}

/**
 * Extracts decision events from a single chunk and inserts them into the decision ledger.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} chunk - Chunk record from SQLite
 * @param {Function} [llm=chatCompletion] - LLM caller function
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {boolean} [options.skipIfExtracted=true]
 * @param {boolean} [options.force=false]
 * @returns {Promise<{
 *   chunkId: string|number,
 *   skipped: boolean,
 *   inserted: Array<object>,
 *   duplicatesCount: number,
 *   rejectedQuotesCount: number,
 *   missingTopicCount: number,
 *   invalidSchemaCount: number,
 *   error: string|null
 * }>}
 */
export async function extractEventsFromChunk(db, chunk, llm = chatCompletion, options = {}) {
  let targetDb = db;
  let targetChunk = chunk;
  let targetLlm = llm;
  let targetOptions = options;

  if (targetDb && !targetDb.prepare && targetChunk && typeof targetChunk === 'function') {
    targetOptions = targetLlm || {};
    targetLlm = targetChunk;
    targetChunk = targetDb;
    targetDb = targetChunk.db;
  }

  if (!targetChunk || !targetChunk.id || !targetChunk.chunk_text) {
    throw new Error('chunk must be a valid object with id and chunk_text');
  }

  const force = targetOptions.force === true;
  const skipIfExtracted = !force && targetOptions.skipIfExtracted !== false;

  // 1. Check if chunk was already extracted (unless force is true)
  if (skipIfExtracted && targetDb) {
    const existing = targetDb.prepare('SELECT chunk_id FROM chunk_extractions WHERE chunk_id = ?').get(targetChunk.id);
    if (existing) {
      return {
        chunkId: targetChunk.id,
        skipped: true,
        inserted: [],
        duplicatesCount: 0,
        rejectedQuotesCount: 0,
        missingTopicCount: 0,
        invalidSchemaCount: 0,
        error: null,
      };
    }
  }

  const userPrompt = `Source Location: ${targetChunk.source_location || targetChunk.relative_path || 'unknown'}
Lines: ${targetChunk.start_line || '?'}-${targetChunk.end_line || '?'}

Text Snippet:
"""
${targetChunk.chunk_text}
"""

Extract all explicit decision events matching the requested JSON schema. If none, return {"events": []}.`;

  let response;
  try {
    response = await targetLlm([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ], {
      temperature: 0,
      model: targetOptions.model,
      response_format: EXTRACTION_RESPONSE_FORMAT,
    });
  } catch (err) {
    return {
      chunkId: targetChunk.id,
      skipped: false,
      inserted: [],
      duplicatesCount: 0,
      rejectedQuotesCount: 0,
      missingTopicCount: 0,
      invalidSchemaCount: 0,
      error: `LLM extraction failed: ${err.message}`,
    };
  }

  const rawEvents = parseModelJson(response.text);
  const inserted = [];
  let duplicatesCount = 0;
  let rejectedQuotesCount = 0;
  let missingTopicCount = 0;
  let invalidSchemaCount = 0;

  const seenSignatures = new Set();

  for (const rawEvent of rawEvents) {
    if (!rawEvent || typeof rawEvent !== 'object') {
      invalidSchemaCount++;
      continue;
    }

    // Defensive alias mapping
    const eventType = rawEvent.event_type || rawEvent.eventType || rawEvent.type;
    const actorName = (rawEvent.actor_name !== undefined && rawEvent.actor_name !== null && String(rawEvent.actor_name).trim() !== '')
      ? rawEvent.actor_name
      : (rawEvent.actor || rawEvent.actorName || null);

    const eventDate = (rawEvent.event_date !== undefined && rawEvent.event_date !== null && String(rawEvent.event_date).trim() !== '')
      ? rawEvent.event_date
      : (rawEvent.date || rawEvent.eventDate || null);

    const actorOrg = rawEvent.actor_organization ?? rawEvent.actorOrganization ?? rawEvent.organization ?? rawEvent.org ?? null;
    const exactQuote = rawEvent.exact_quote ?? rawEvent.exactQuote ?? rawEvent.quote;
    const topic = rawEvent.topic;
    const value = rawEvent.value ?? null;
    const confidence = typeof rawEvent.confidence === 'number' && !Number.isNaN(rawEvent.confidence)
      ? Math.min(1.0, Math.max(0.0, rawEvent.confidence))
      : 0.85;

    // Validate enum
    if (!eventType || !VALID_EVENT_TYPES.has(eventType)) {
      invalidSchemaCount++;
      continue;
    }

    // Explicit check for missing topic - never invent topics in code
    if (!topic || typeof topic !== 'string' || !topic.trim()) {
      missingTopicCount++;
      continue;
    }

    if (!exactQuote || typeof exactQuote !== 'string' || !exactQuote.trim()) {
      invalidSchemaCount++;
      continue;
    }

    // In-memory deduplication within the same chunk
    const sig = `${eventType}::${topic.trim().toLowerCase()}::${exactQuote.trim()}`;
    if (seenSignatures.has(sig)) {
      duplicatesCount++;
      continue;
    }
    seenSignatures.add(sig);

    // Database deduplication (crucial for --force so rerun doesn't duplicate existing events)
    if (targetDb) {
      const existingInDb = targetDb.prepare(`
        SELECT id FROM decision_events
        WHERE chunk_id = ? AND event_type = ? AND topic = ? AND exact_quote = ?
      `).get(targetChunk.id, eventType, topic.trim(), exactQuote);

      if (existingInDb) {
        duplicatesCount++;
        continue;
      }
    }

    // Literal quote verification against chunk text
    if (!targetChunk.chunk_text.includes(exactQuote)) {
      rejectedQuotesCount++;
      continue;
    }

    // Insert via createDecisionEvent
    if (targetDb) {
      try {
        const createdEvent = createDecisionEvent(targetDb, {
          chunk_id: targetChunk.id,
          event_type: eventType,
          topic: topic.trim(),
          value,
          actor_name: actorName,
          actor_organization: actorOrg,
          event_date: eventDate,
          exact_quote: exactQuote,
          confidence,
          verification_status: 'candidate',
        });
        inserted.push(createdEvent);
      } catch (err) {
        if (err.message.includes('Grounding validation failed') || err.message.includes('exact_quote')) {
          rejectedQuotesCount++;
        } else {
          invalidSchemaCount++;
        }
      }
    } else {
      // In-memory / dry-run candidate record
      inserted.push({
        chunk_id: targetChunk.id,
        event_type: eventType,
        topic: topic.trim(),
        value,
        actor_name: actorName,
        actor_organization: actorOrg,
        event_date: eventDate,
        exact_quote: exactQuote,
        confidence,
        verification_status: 'candidate',
      });
    }
  }

  // 4. Record extraction completion in chunk_extractions table
  if (targetDb) {
    const modelName = response.model || targetOptions.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    targetDb.prepare(`
      INSERT OR REPLACE INTO chunk_extractions (
        chunk_id, extractor_version, model_name, completed_at, event_count
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      targetChunk.id,
      EXTRACTOR_VERSION,
      modelName,
      new Date().toISOString(),
      inserted.length
    );
  }

  return {
    chunkId: targetChunk.id,
    skipped: false,
    inserted,
    duplicatesCount,
    rejectedQuotesCount,
    missingTopicCount,
    invalidSchemaCount,
    error: null,
  };
}

/**
 * Processes chunks across the database using bounded concurrency.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {Function} [options.llm=chatCompletion]
 * @param {number} [options.limit]
 * @param {boolean} [options.resume=true]
 * @param {boolean} [options.force=false]
 * @param {number} [options.concurrency=2]
 * @param {Function} [options.onProgress]
 * @returns {Promise<{
 *   totalChunks: number,
 *   processedChunks: number,
 *   skippedChunks: number,
 *   candidateEventsInserted: number,
 *   duplicatesSkipped: number,
 *   invalidQuotesRejected: number,
 *   missingTopicsRejected: number,
 *   invalidSchemaRejected: number,
 *   errors: Array<{ chunkId: string|number, error: string }>,
 *   elapsedMs: number
 * }>}
 */
export async function extractAllChunks(db, options = {}) {
  const llm = options.llm || chatCompletion;
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : null;
  const force = options.force === true;
  const resume = !force && options.resume !== false;
  const concurrency = typeof options.concurrency === 'number' && options.concurrency > 0 ? options.concurrency : 2;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const startTime = Date.now();

  // Query chunks needing extraction
  let query = `
    SELECT
      c.id, c.document_id, c.chunk_index, c.chunk_text,
      c.start_line, c.end_line, c.source_location, d.relative_path
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
  `;

  if (resume) {
    query += ` WHERE c.id NOT IN (SELECT chunk_id FROM chunk_extractions) `;
  }

  query += ` ORDER BY c.document_id ASC, c.chunk_index ASC `;

  if (limit) {
    query += ` LIMIT ${Number(limit)} `;
  }

  const chunksToProcess = db.prepare(query).all();
  const totalChunks = chunksToProcess.length;

  let processedChunks = 0;
  let skippedChunks = 0;
  let candidateEventsInserted = 0;
  let duplicatesSkipped = 0;
  let invalidQuotesRejected = 0;
  let missingTopicsRejected = 0;
  let invalidSchemaRejected = 0;
  const errors = [];

  // Bounded concurrency pool
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < chunksToProcess.length) {
      const chunk = chunksToProcess[currentIndex++];
      const result = await extractEventsFromChunk(db, chunk, llm, {
        skipIfExtracted: resume,
        force,
        model: options.model,
      });

      if (result.skipped) {
        skippedChunks++;
      } else {
        processedChunks++;
        candidateEventsInserted += result.inserted.length;
        duplicatesSkipped += result.duplicatesCount;
        invalidQuotesRejected += result.rejectedQuotesCount;
        missingTopicsRejected += result.missingTopicCount;
        invalidSchemaRejected += result.invalidSchemaCount;

        if (result.error) {
          errors.push({ chunkId: chunk.id, error: result.error });
        }
      }

      onProgress({
        chunkId: chunk.id,
        processed: processedChunks,
        total: totalChunks,
        insertedCount: result.inserted.length,
        rejectedQuotesCount: result.rejectedQuotesCount,
        missingTopicCount: result.missingTopicCount,
        invalidSchemaCount: result.invalidSchemaCount,
        duplicatesCount: result.duplicatesCount,
        error: result.error,
      });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, chunksToProcess.length || 1) }, () => worker());
  await Promise.all(workers);

  return {
    totalChunks,
    processedChunks,
    skippedChunks,
    candidateEventsInserted,
    duplicatesSkipped,
    invalidQuotesRejected,
    missingTopicsRejected,
    invalidSchemaRejected,
    errors,
    elapsedMs: Date.now() - startTime,
  };
}
