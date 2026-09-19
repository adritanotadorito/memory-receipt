# Privacy & Cost Guardrails

## Overview

“Memory With a Receipt” is an evidence-first enterprise decision-memory system designed to answer questions using strictly verified source records. This document details the privacy minimisation architecture, token budget guardrails, usage audit trail, and honest system boundaries implemented in the prototype.

> **Architecture Disclosure:** “Local retrieval” means SQLite/FTS5 and local embeddings run entirely on-device; final answer synthesis uses the configured OpenAI API. Source content does not stay entirely local: a strictly bounded, selected evidence packet is sent to the model for grounded synthesis.

---

## 1. Data-Minimised LLM Evidence Packets

Rather than dumping whole documents or oversized corpora into a generative model, the answering pipeline applies deterministic minimisation before any network payload is constructed:

1. **Local Search & Hybrid Ranking:**
   - Query tokenisation and semantic embeddings execute locally.
   - Candidate chunks are retrieved from SQLite and FTS5 up to `MAX_RETRIEVED_CHUNKS` (default: `8`).
2. **Metadata & Benchmark File Exclusions:**
   - Administrative files (`00_README.md`, `PRACTICE-QUESTIONS.md`) are hard-filtered and never enter the prompt packet.
3. **Chunk-Boundary Preservation (Character Limit):**
   - The combined excerpt text is bounded by `MAX_EVIDENCE_CHARS` (default: `12,000` characters).
   - Whole chunks are added in rank order while they fit within the budget.
   - If the first ranked chunk alone exceeds the character budget, that single chunk is included in full to ensure the system can answer without failing silently.
   - **No text mutation:** Chunks are never sliced in half or silently redacted. Preserving whole chunks ensures exact line coordinates and verbatim receipt quotes remain 100% verifiable.
4. **Token Generation Caps:**
   - Answer completions are bounded by `MAX_COMPLETION_TOKENS` (default: `700` tokens) with structured JSON schema enforcement (`json_schema`).

---

## 2. Privacy-Preserving Usage Ledger

All synthesis requests write an immutable accounting record to the SQLite `llm_usage_log` table:

```sql
CREATE TABLE IF NOT EXISTS llm_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  retrieved_chunk_count INTEGER NOT NULL,
  included_chunk_count INTEGER NOT NULL,
  evidence_char_count INTEGER NOT NULL,
  success INTEGER NOT NULL CHECK(success IN (0, 1)),
  error_category TEXT
);
```

### What is Logged:
- Concrete token counts (`prompt_tokens`, `completion_tokens`, `total_tokens`).
- Data-minimisation counters (`retrieved_chunk_count`, `included_chunk_count`, `evidence_char_count`).
- Status and safe categorical error classes (`timeout`, `upstream_http`, `network`, `invalid_response`, `validation`).
- Timestamp, operation name (`answer`), and model identifier.

### What is Deliberately NOT Logged:
- **No API keys or credentials** (kept server-side in environment variables, never sent to the browser or stored in database logs).
- **No raw user questions or prompts.**
- **No source text or excerpt contents.**
- **No raw upstream error bodies** that might reflect user questions or corpus excerpts.

### Usage Summary API:
Administrators can inspect token consumption via `GET /api/usage-summary`, which returns:
- `answerRequests`: Total number of answer requests executed.
- `totalPromptTokens`, `totalCompletionTokens`, `totalTokens`: Token expenditures.
- `averageTokensPerSuccessfulAnswer`: Real average token cost per successful answer.
- `latestAnswer`: Data-minimisation metrics for the most recent answer.

*Note on currency:* Token metrics are reported directly rather than converted into estimated or fabricated Euro/Dollar amounts.

---

## 3. Deletion Cascade & Right-to-be-Forgotten

When an individual exercises their right to be forgotten:
1. **Durable Tombstone:** An entry is added to `deletion_tombstones` to permanently immunize against data resurrection during future corpus re-ingestion runs.
2. **Foreign-Key Cascade Deletion:** Target text chunks, FTS5 virtual table entries, vector embeddings (`chunk_embeddings`), decision ledger events (`decision_events`), graph relations (`event_relations`), and extraction records (`chunk_extractions`) are deleted within a single atomic SQLite transaction.
3. **Verification & Audit Trail:** Deletion actions are logged to `audit_log` with before/after row counts, and verified to have zero residual trace in any derived system store.

---

## 4. Real Implementation vs. Planned Production Capabilities

| Feature / Capability | Implementation State in Prototype | Planned Production Requirement |
| :--- | :--- | :--- |
| **Local Search & Embeddings** | **Real** (SQLite FTS5 + local embeddings) | Production multi-tenant vector engine |
| **Source Data Minimisation** | **Real** (Configurable chunk, character, and token limits) | Dynamic adaptive context compression |
| **Receipt Verification** | **Real** (Code-verified quotes and exact line citations) | Automated drift detection |
| **Token Usage Ledger** | **Real** (Zero-prompt SQLite audit log + summary API) | Centralized Prometheus / OpenTelemetry metrics |
| **GDPR Deletion Cascade** | **Real** (Tombstones + full cascade purge across all stores) | Distributed webhook deletion across external connectors |
| **Permission-Aware Retrieval** | **Planned (Not Implemented)** | Real-time ACL filtering based on employee Slack, email, and Google Drive permissions |
| **Enterprise Authentication** | **Planned (Not Implemented)** | Single Sign-On (SSO) via SAML / OAuth 2.0 / OIDC |
