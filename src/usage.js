/**
 * Privacy-preserving usage ledger: tracks token expenditures and data-minimisation metrics
 * without logging raw questions, prompts, or source text.
 */

/**
 * Logs an LLM usage event to the SQLite usage ledger.
 * Strictly records numeric counters and categorical metadata.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} record
 * @param {string} [record.operation='answer']
 * @param {string} [record.model='gpt-4.1-mini']
 * @param {number} [record.prompt_tokens=0]
 * @param {number} [record.completion_tokens=0]
 * @param {number} [record.total_tokens=0]
 * @param {number} [record.retrieved_chunk_count=0]
 * @param {number} [record.included_chunk_count=0]
 * @param {number} [record.evidence_char_count=0]
 * @param {boolean|number} [record.success=true]
 * @param {string|null} [record.error_category=null]
 * @param {string} [record.created_at]
 * @returns {number} Inserted row ID
 */
export function logLlmUsage(db, record = {}) {
  const createdAt = record.created_at || new Date().toISOString();
  const operation = record.operation || 'answer';
  const model = record.model || 'gpt-4.1-mini';
  const promptTokens = Number(record.prompt_tokens ?? record.promptTokens ?? 0) || 0;
  const completionTokens = Number(record.completion_tokens ?? record.completionTokens ?? 0) || 0;
  const totalTokens = Number(record.total_tokens ?? record.totalTokens ?? (promptTokens + completionTokens)) || 0;
  const retrievedChunkCount = Number(record.retrieved_chunk_count ?? record.retrievedChunkCount ?? 0) || 0;
  const includedChunkCount = Number(record.included_chunk_count ?? record.includedChunkCount ?? 0) || 0;
  const evidenceCharCount = Number(record.evidence_char_count ?? record.evidenceCharCount ?? 0) || 0;
  const success = record.success === false || record.success === 0 ? 0 : 1;
  const errorCategory = record.error_category ?? record.errorCategory ?? null;

  const stmt = db.prepare(`
    INSERT INTO llm_usage_log (
      created_at,
      operation,
      model,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      retrieved_chunk_count,
      included_chunk_count,
      evidence_char_count,
      success,
      error_category
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    createdAt,
    operation,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    retrievedChunkCount,
    includedChunkCount,
    evidenceCharCount,
    success,
    errorCategory
  );

  return result.lastInsertRowid;
}

/**
 * Queries the usage ledger and returns honest aggregate token counts and data-minimisation metrics.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{
 *   answerRequests: number,
 *   totalPromptTokens: number,
 *   totalCompletionTokens: number,
 *   totalTokens: number,
 *   averageTokensPerSuccessfulAnswer: number,
 *   latestAnswer: {
 *     retrievedChunkCount: number,
 *     includedChunkCount: number,
 *     evidenceCharCount: number,
 *     promptTokens: number,
 *     completionTokens: number,
 *     totalTokens: number,
 *     createdAt: string
 *   } | null
 * }}
 */
export function getUsageSummary(db) {
  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN operation = 'answer' THEN 1 ELSE 0 END) as answer_requests,
      SUM(prompt_tokens) as total_prompt_tokens,
      SUM(completion_tokens) as total_completion_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(CASE WHEN success = 1 AND operation = 'answer' THEN total_tokens ELSE 0 END) as successful_answer_tokens,
      SUM(CASE WHEN success = 1 AND operation = 'answer' THEN 1 ELSE 0 END) as successful_answer_count
    FROM llm_usage_log
  `).get() || {};

  const answerRequests = Number(totals.answer_requests || 0);
  const totalPromptTokens = Number(totals.total_prompt_tokens || 0);
  const totalCompletionTokens = Number(totals.total_completion_tokens || 0);
  const totalTokens = Number(totals.total_tokens || 0);
  const successfulAnswerTokens = Number(totals.successful_answer_tokens || 0);
  const successfulAnswerCount = Number(totals.successful_answer_count || 0);

  const averageTokensPerSuccessfulAnswer = successfulAnswerCount > 0
    ? Math.round(successfulAnswerTokens / successfulAnswerCount)
    : 0;

  const latestRow = db.prepare(`
    SELECT
      retrieved_chunk_count,
      included_chunk_count,
      evidence_char_count,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      created_at
    FROM llm_usage_log
    WHERE operation = 'answer'
    ORDER BY id DESC
    LIMIT 1
  `).get();

  const latestAnswer = latestRow
    ? {
        retrievedChunkCount: Number(latestRow.retrieved_chunk_count || 0),
        includedChunkCount: Number(latestRow.included_chunk_count || 0),
        evidenceCharCount: Number(latestRow.evidence_char_count || 0),
        promptTokens: Number(latestRow.prompt_tokens || 0),
        completionTokens: Number(latestRow.completion_tokens || 0),
        totalTokens: Number(latestRow.total_tokens || 0),
        createdAt: latestRow.created_at,
      }
    : null;

  return {
    answerRequests,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    averageTokensPerSuccessfulAnswer,
    latestAnswer,
  };
}
