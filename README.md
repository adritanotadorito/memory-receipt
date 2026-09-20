# Memory With a Receipt

Memory With a Receipt is an evidence-first decision-memory and retrieval-augmented generation (RAG) assistant designed for project communications across transcripts, emails, and steering reports. Rather than generating ungrounded summaries, the system anchors every claim in verified evidence: each synthesized answer is accompanied by literal quotes, exact source files, and line ranges validated against the underlying corpus.

Live demo: https://memory-receipt.onrender.com

## Key Features

- **Hybrid local retrieval**: SQLite FTS5 keyword search + local MiniLM semantic embeddings + Reciprocal Rank Fusion
- **Verified receipts**: Citations and literal quote validation
- **Structured decision ledger**: Proposals, commitments, status updates, reversals, issues, actions, and rejections
- **PII and credential masking**: Automatic sanitization before external answer synthesis
- **Bounded evidence and cost controls**: Enforced character budgets, token limits, and usage logging
- **Derived-data deletion**: Tombstone-based deletion with Decision Blast Radius preview

## Tech Stack

- Node.js & Express
- SQLite via `better-sqlite3` & SQLite FTS5
- `@xenova/transformers` (MiniLM embeddings)
- OpenAI API for bounded answer synthesis
- Cytoscape

## How It Works

```
Sources → 30-line overlapping chunks → Local keyword + semantic retrieval → Bounded evidence packet → Answer synthesis → Verified receipts
```

## Local Run Instructions

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file in the project root containing your API key (and optionally model configuration):
   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   OPENAI_MODEL=gpt-4.1-mini
   ```

3. Start the application:
   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Testing

Run the test suite:

```bash
npm test
```

## Prototype Boundaries

This prototype uses a supplied synthetic corpus. It is GDPR-aligned by design, not a claim of full GDPR compliance. Production would require permission-aware Slack/email/document connectors and organisational data-governance controls.
