import { hybridSearch } from './hybrid.js';
import { chatCompletion } from './llm.js';
import { logLlmUsage } from './usage.js';
import { createPiiShieldContext, redactPii } from './pii-shield.js';

export const VALID_STATUSES = new Set(['answered', 'conflicting_evidence', 'insufficient_evidence']);
export const VALID_CURRENCIES = new Set(['current', 'historical', 'uncertain']);

const EXCLUDED_FILENAMES = new Set(['00_README.md', 'PRACTICE-QUESTIONS.md']);

export const ANSWER_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'evidence_grounded_answer',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['answered', 'conflicting_evidence', 'insufficient_evidence'],
          description: 'Certainty status: "answered" if clearly resolved by receipts, "conflicting_evidence" if contradictory receipts without resolution, "insufficient_evidence" if unmentioned or ambiguous.',
        },
        answer: {
          type: 'string',
          description: 'Direct answer in no more than two plain-English sentences. State the current decision first.',
        },
        claims: {
          type: 'array',
          description: 'Atomic factual propositions that make up the answer, each strictly referencing one or more verified receipt IDs.',
          items: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'One atomic factual claim without vague inference words',
              },
              receipt_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of pre-verified Receipt IDs (e.g. ["event-1", "event-2"]) supporting this claim',
              },
              currency: {
                type: 'string',
                enum: ['current', 'historical', 'uncertain'],
                description: '"current" if this is the active/final decision, "historical" if it was an earlier proposal/superseded state, "uncertain" if unresolved',
              },
            },
            required: ['text', 'receipt_ids', 'currency'],
            additionalProperties: false,
          },
        },
        reasoning_note: {
          type: ['string', 'null'],
          description: 'Short explanatory note on conflicts or uncertainty, or null if answered clearly',
        },
      },
      required: ['status', 'answer', 'claims', 'reasoning_note'],
      additionalProperties: false,
    },
  },
};

export const ANSWER_SYSTEM_PROMPT = `You are an evidence-first answering engine for enterprise memory ("Memory With a Receipt").
Your task is to answer the user's question concisely and directly using ONLY the provided verified decision receipts and source evidence.

STRICT GROUNDING & RECEIPT RULES:
1. Direct, Concise Answer:
   - Provide a direct answer in NO MORE THAN TWO plain-English sentences.
   - State the current decision/state FIRST.
   - Never use vague inference wording such as "indicating", "suggests", or "appears" when direct receipt evidence is available.
2. Atomic Claims & Receipt References:
   - Each claim must be a single atomic factual proposition. Do not combine multiple decisions into one claim.
   - Every claim MUST cite one or more valid Receipt IDs (e.g., ["event-123"]) from the packet.
   - A receipt's exact quote and metadata is the ONLY approved evidence.
   - Never invent receipt IDs, facts, people, dates, or decisions.
3. Currency & Temporal Precision:
   - "currency" must be:
     * "current": ONLY when the supplied receipt chronology explicitly establishes it as the latest/active position.
     * "historical": If the claim represents an earlier proposal, prior phase, or superseded state. Put historical context in a separate claim only if it materially explains the decision.
     * "uncertain": If it is ambiguous whether this position remains active.
   - If a current state cannot be proven, say so clearly and set status accordingly.
4. Status Rules:
   - "answered": The receipts clearly establish the current answer.
   - "conflicting_evidence": Different receipts directly contradict each other and no subsequent receipt resolves the discrepancy.
   - "insufficient_evidence": The receipts do not contain enough facts to answer the question.
5. Strict JSON Schema:
   - Output MUST adhere strictly to the JSON schema. Do not output markdown fences or conversational preambles.`;

export function parseAnswerResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return null;
  }

  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return null;
  } catch {
    const objMatch = cleaned.match(/\{[\s\S]*"status"[\s\S]*"answer"[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch { }
    }
    return null;
  }
}

export async function answerQuestion(db, question, llm = chatCompletion, options = {}) {
  if (!question || typeof question !== 'string' || !question.trim()) {
    throw new Error('question must be a non-empty string');
  }

  const maxRetrievedChunks = Number(
    options.limit ?? options.maxRetrievedChunks ?? process.env.MAX_RETRIEVED_CHUNKS ?? 8
  );
  const maxEvidenceChars = Number(
    options.maxEvidenceChars ?? options.max_evidence_chars ?? process.env.MAX_EVIDENCE_CHARS ?? 12000
  );
  const maxCompletionTokens = Number(
    options.max_tokens ?? options.maxTokens ?? options.maxCompletionTokens ?? process.env.MAX_COMPLETION_TOKENS ?? 700
  );

  const rawHits = await hybridSearch(db, question.trim(), { limit: maxRetrievedChunks + 4 });

  const filteredHits = rawHits.filter((h) => {
    const filename = h.filename || '';
    const relPath = h.relativePath || '';
    return (
      !EXCLUDED_FILENAMES.has(filename) &&
      !EXCLUDED_FILENAMES.has(relPath) &&
      !relPath.includes('00_README.md') &&
      !relPath.includes('PRACTICE-QUESTIONS.md')
    );
  }).slice(0, maxRetrievedChunks);

  const retrievedChunkCount = filteredHits.length;

  if (retrievedChunkCount === 0) {
    return {
      status: 'insufficient_evidence',
      answer: 'No relevant documents were found in the corpus to answer this question.',
      claims: [],
      reasoningNote: 'Hybrid search returned zero matching chunks.',
      citations: [],
      events: [],
      receipts: [],
      retrieval: [],
      metrics: {
        retrievedChunkCount: 0,
        includedChunkCount: 0,
        evidenceCharCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        emailsRedacted: 0,
        phonesRedacted: 0,
        totalDirectIdentifiersRedacted: 0,
      },
    };
  }

  const candidateChunkIds = filteredHits.map((h) => h.chunkId);
  const candidatePlaceholders = candidateChunkIds.map(() => '?').join(',');

  const chunkRows = db.prepare(`
    SELECT c.id, c.start_line, c.end_line, c.source_location, c.chunk_text, d.relative_path, d.category, d.filename
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE c.id IN (${candidatePlaceholders})
  `).all(...candidateChunkIds);

  const chunkDetailMap = new Map(chunkRows.map((r) => [r.id, r]));

  const includedHits = [];
  let cumulativeChunkChars = 0;

  for (let i = 0; i < filteredHits.length; i++) {
    const hit = filteredHits[i];
    const detail = chunkDetailMap.get(hit.chunkId) || {};
    const chunkText = hit.exactSourceText || detail.chunk_text || '';
    const textLength = chunkText.length;

    if (includedHits.length === 0) {

      includedHits.push(hit);
      cumulativeChunkChars += textLength;
    } else if (cumulativeChunkChars + textLength <= maxEvidenceChars) {
      includedHits.push(hit);
      cumulativeChunkChars += textLength;
    } else {

      break;
    }
  }

  const includedChunkCount = includedHits.length;
  const includedChunkIds = includedHits.map((h) => h.chunkId);
  const includedPlaceholders = includedChunkIds.map(() => '?').join(',');

  const eventRows = includedChunkIds.length > 0
    ? db.prepare(`
        SELECT
          de.id,
          de.chunk_id,
          de.event_type,
          de.topic,
          de.value,
          de.actor_name,
          de.actor_organization,
          de.event_date,
          de.exact_quote,
          de.confidence,
          de.verification_status,
          de.created_at,
          c.source_location,
          c.start_line,
          c.end_line,
          d.relative_path,
          d.category,
          d.filename
        FROM decision_events de
        JOIN chunks c ON de.chunk_id = c.id
        JOIN documents d ON c.document_id = d.id
        WHERE de.chunk_id IN (${includedPlaceholders})
        ORDER BY de.event_date ASC, de.id ASC
      `).all(...includedChunkIds)
    : [];

  const allReceipts = [];
  const receiptMap = new Map();

  for (const ev of eventRows) {
    const receiptId = `event-${ev.id}`;
    const receipt = {
      receiptId,
      eventId: ev.id,
      eventType: ev.event_type,
      topic: ev.topic,
      value: ev.value,
      actorName: ev.actor_name,
      actorOrganization: ev.actor_organization,
      eventDate: ev.event_date,
      exactQuote: ev.exact_quote,
      confidence: ev.confidence,
      verificationStatus: ev.verification_status,
      chunkId: ev.chunk_id,
      sourceLocation: ev.source_location,
      relativePath: ev.relative_path,
      startLine: ev.start_line,
      endLine: ev.end_line,
      category: ev.category,
      filename: ev.filename,
    };

    allReceipts.push(receipt);
    receiptMap.set(receiptId, receipt);
    receiptMap.set(receiptId.toLowerCase(), receipt);
    receiptMap.set(String(ev.id), receipt);
    receiptMap.set(`event_${ev.id}`, receipt);
  }

  let receiptsFormatted = '';
  if (allReceipts.length > 0) {
    receiptsFormatted = allReceipts.map((r) => {
      const actor = r.actorName ? ` | Actor: ${r.actorName}` : '';
      const date = r.eventDate ? ` | Date: ${r.eventDate}` : '';
      const val = r.value ? ` | Value: "${r.value}"` : '';
      return `[Receipt ID: ${r.receiptId}]
Type: ${r.eventType} | Topic: "${r.topic}"${val}${actor}${date}
Source: ${r.sourceLocation} (${r.category})
Quote: "${r.exactQuote}"`;
    }).join('\n\n');
  } else {
    receiptsFormatted = 'No verified decision receipts were found for the retrieved chunks.';
  }

  const chunksFormatted = includedHits.map((hit) => {
    const detail = chunkDetailMap.get(hit.chunkId) || {};
    const loc = hit.sourceLocation || detail.source_location || 'unknown location';
    const cat = hit.category || detail.category || 'unknown';
    const text = hit.exactSourceText || detail.chunk_text || '';
    return `[Source Document: ${loc} (${cat})]
"""
${text}
"""`;
  }).join('\n\n---\n\n');

  const piiContext = createPiiShieldContext();
  const redactedQuestion = redactPii(question.trim(), piiContext).text;
  const redactedReceipts = redactPii(receiptsFormatted, piiContext).text;
  const redactedChunks = redactPii(chunksFormatted, piiContext).text;

  const evidenceCharCount = receiptsFormatted.length + chunksFormatted.length;

  const userPrompt = `Question: "${redactedQuestion}"

=== VERIFIED DECISION RECEIPTS ===
${redactedReceipts}

=== SUPPORTING SOURCE DOCUMENTS ===
${redactedChunks}

Analyze the verified decision receipts above and synthesize a strictly grounded, concise answer matching the requested JSON schema. Every claim MUST cite one or more valid Receipt IDs (e.g. ["event-123"]).`;

  let response;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  try {
    response = await llm([
      { role: 'system', content: ANSWER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ], {
      temperature: 0,
      model: options.model,
      max_tokens: maxCompletionTokens,
      response_format: ANSWER_RESPONSE_FORMAT,
    });

    promptTokens = Number(response?.usage?.prompt_tokens || 0);
    completionTokens = Number(response?.usage?.completion_tokens || 0);
    totalTokens = Number(response?.usage?.total_tokens || (promptTokens + completionTokens));
  } catch (err) {
    const errMsg = String(err.message || '').toLowerCase();
    let errorCategory = 'unhandled';
    if (errMsg.includes('timeout') || errMsg.includes('timed out') || errMsg.includes('aborted')) {
      errorCategory = 'timeout';
    } else if (errMsg.includes('status') || errMsg.includes('http') || errMsg.includes('401') || errMsg.includes('429') || errMsg.includes('500') || errMsg.includes('502') || errMsg.includes('503')) {
      errorCategory = 'upstream_http';
    } else if (errMsg.includes('network') || errMsg.includes('fetch') || errMsg.includes('econnrefused')) {
      errorCategory = 'network';
    } else if (errMsg.includes('json') || errMsg.includes('malformed') || errMsg.includes('invalid')) {
      errorCategory = 'invalid_response';
    }

    try {
      logLlmUsage(db, {
        operation: 'answer',
        model: options.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        retrieved_chunk_count: retrievedChunkCount,
        included_chunk_count: includedChunkCount,
        evidence_char_count: evidenceCharCount,
        success: 0,
        error_category: errorCategory,
      });
    } catch { }

    return {
      status: 'insufficient_evidence',
      answer: 'An error occurred during evidence synthesis.',
      claims: [],
      reasoningNote: `LLM generation error: ${err.message}`,
      citations: [],
      events: eventRows,
      receipts: allReceipts,
      retrieval: includedHits,
      metrics: {
        retrievedChunkCount,
        includedChunkCount,
        evidenceCharCount,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        emailsRedacted: piiContext.emailsRedacted,
        phonesRedacted: piiContext.phonesRedacted,
        totalDirectIdentifiersRedacted: piiContext.emailsRedacted + piiContext.phonesRedacted,
      },
    };
  }

  const parsed = parseAnswerResponse(response.text);

  if (!parsed || !VALID_STATUSES.has(parsed.status) || typeof parsed.answer !== 'string') {
    try {
      logLlmUsage(db, {
        operation: 'answer',
        model: response?.model || options.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        retrieved_chunk_count: retrievedChunkCount,
        included_chunk_count: includedChunkCount,
        evidence_char_count: evidenceCharCount,
        success: 0,
        error_category: 'validation',
      });
    } catch { }

    return {
      status: 'insufficient_evidence',
      answer: 'Insufficient evidence to verify an answer for this question.',
      claims: [],
      reasoningNote: 'Model returned an invalid status or unparseable response structure.',
      citations: [],
      events: eventRows,
      receipts: allReceipts,
      retrieval: includedHits,
      metrics: {
        retrievedChunkCount,
        includedChunkCount,
        evidenceCharCount,
        promptTokens,
        completionTokens,
        totalTokens,
        emailsRedacted: piiContext.emailsRedacted,
        phonesRedacted: piiContext.phonesRedacted,
        totalDirectIdentifiersRedacted: piiContext.emailsRedacted + piiContext.phonesRedacted,
      },
    };
  }

  const rawClaims = Array.isArray(parsed.claims) ? parsed.claims : [];
  const validatedClaims = [];
  const citedReceiptSet = new Set();
  let droppedClaimsCount = 0;

  for (const claim of rawClaims) {
    if (!claim || typeof claim.text !== 'string' || !claim.text.trim()) {
      droppedClaimsCount++;
      continue;
    }

    const receiptIds = Array.isArray(claim.receipt_ids)
      ? claim.receipt_ids
      : (Array.isArray(claim.evidence_ids) ? claim.evidence_ids : []);

    if (receiptIds.length === 0) {
      droppedClaimsCount++;
      continue;
    }

    const currency = VALID_CURRENCIES.has(claim.currency) ? claim.currency : 'uncertain';
    const resolvedReceipts = [];
    let claimHasInvalidReceipt = false;

    for (const rawId of receiptIds) {
      const normalizedId = String(rawId).trim().toLowerCase();
      const matchedReceipt = receiptMap.get(normalizedId)
        || receiptMap.get(normalizedId.replace(/^event-/, ''))
        || receiptMap.get(`event-${normalizedId}`);

      if (!matchedReceipt) {
        claimHasInvalidReceipt = true;
        break;
      }

      resolvedReceipts.push(matchedReceipt);
    }

    if (claimHasInvalidReceipt || resolvedReceipts.length === 0) {
      droppedClaimsCount++;
      continue;
    }

    const verifiedQuotes = resolvedReceipts.map((r) => r.exactQuote);
    const verifiedReceiptIds = resolvedReceipts.map((r) => r.receiptId);

    resolvedReceipts.forEach((r) => {
      citedReceiptSet.add(r.receiptId);
    });

    validatedClaims.push({
      text: claim.text.trim(),
      receipt_ids: Array.from(new Set(verifiedReceiptIds)),
      evidence_ids: Array.from(new Set(verifiedReceiptIds)),
      evidence_quotes: Array.from(new Set(verifiedQuotes)),
      evidence_quote: verifiedQuotes[0] || '',
      receipts: resolvedReceipts,
      currency,
    });
  }

  if (validatedClaims.length === 0) {

    try {
      logLlmUsage(db, {
        operation: 'answer',
        model: response?.model || options.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        retrieved_chunk_count: retrievedChunkCount,
        included_chunk_count: includedChunkCount,
        evidence_char_count: evidenceCharCount,
        success: 1,
        error_category: null,
      });
    } catch { }

    if (parsed.status === 'answered') {
      return {
        status: 'insufficient_evidence',
        answer: 'Insufficient verified evidence found in the corpus to answer this question.',
        claims: [],
        reasoningNote: droppedClaimsCount > 0
          ? 'All proposed claims referenced invalid receipt IDs and were dropped.'
          : 'Model generated zero verifiable claims.',
        citations: [],
        events: eventRows,
        receipts: allReceipts,
        retrieval: includedHits,
        metrics: {
          retrievedChunkCount,
          includedChunkCount,
          evidenceCharCount,
          promptTokens,
          completionTokens,
          totalTokens,
          emailsRedacted: piiContext.emailsRedacted,
          phonesRedacted: piiContext.phonesRedacted,
          totalDirectIdentifiersRedacted: piiContext.emailsRedacted + piiContext.phonesRedacted,
        },
      };
    }

    return {
      status: parsed.status,
      answer: parsed.answer.trim() || 'Insufficient verified evidence found in the corpus to answer this question.',
      claims: [],
      reasoningNote: parsed.reasoning_note || null,
      citations: [],
      events: eventRows,
      receipts: allReceipts,
      retrieval: includedHits,
      metrics: {
        retrievedChunkCount,
        includedChunkCount,
        evidenceCharCount,
        promptTokens,
        completionTokens,
        totalTokens,
        emailsRedacted: piiContext.emailsRedacted,
        phonesRedacted: piiContext.phonesRedacted,
        totalDirectIdentifiersRedacted: piiContext.emailsRedacted + piiContext.phonesRedacted,
      },
    };
  }

  const uniqueReceiptIds = Array.from(citedReceiptSet);
  const citations = uniqueReceiptIds.map((rid, idx) => {
    const r = receiptMap.get(rid.toLowerCase());
    return {
      citationNumber: idx + 1,
      receiptId: r.receiptId,
      eventId: r.eventId,
      chunkId: r.chunkId,
      sourceLocation: r.sourceLocation,
      relativePath: r.relativePath,
      startLine: r.startLine,
      endLine: r.endLine,
      category: r.category,
      exactQuote: r.exactQuote,
      eventType: r.eventType,
      topic: r.topic,
      value: r.value,
      eventDate: r.eventDate,
      actorName: r.actorName,
    };
  });

  try {
    logLlmUsage(db, {
      operation: 'answer',
      model: response?.model || options.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      retrieved_chunk_count: retrievedChunkCount,
      included_chunk_count: includedChunkCount,
      evidence_char_count: evidenceCharCount,
      success: 1,
      error_category: null,
    });
  } catch { }

  return {
    status: parsed.status,
    answer: parsed.answer.trim(),
    claims: validatedClaims,
    reasoningNote: parsed.reasoning_note || null,
    citations,
    events: eventRows,
    receipts: allReceipts,
    retrieval: includedHits,
    metrics: {
      retrievedChunkCount,
      includedChunkCount,
      evidenceCharCount,
      promptTokens,
      completionTokens,
      totalTokens,
      emailsRedacted: piiContext.emailsRedacted,
      phonesRedacted: piiContext.phonesRedacted,
      totalDirectIdentifiersRedacted: piiContext.emailsRedacted + piiContext.phonesRedacted,
    },
  };
}
