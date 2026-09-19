import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export function ensureSeededDatabase(
  dbPath = process.env.DB_PATH || 'data/memory.db',
  seedPath = process.env.SEED_DB_PATH || (fs.existsSync('seed/memory.db') ? 'seed/memory.db' : 'seed/demo-seed.db')
) {
  if (!dbPath || dbPath === ':memory:') {
    return false;
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(dbPath) && fs.existsSync(seedPath)) {
    fs.copyFileSync(seedPath, dbPath);
    console.log(`[db] Initialized runtime database at '${dbPath}' from seed '${seedPath}'.`);
    return true;
  }

  return false;
}

export function initDatabase(dbPath = 'data/memory.db') {

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Table to track source documents ingested from the corpus
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      relative_path TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('email', 'report', 'transcript')),
      imported_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      total_lines INTEGER NOT NULL
    );

    -- Table to store verifiable, overlapping line-based chunks for each document
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      source_location TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_source_location ON chunks(source_location);

    -- Table to maintain an immutable audit trail of document ingestion, updates, and skips
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      document_id TEXT,
      relative_path TEXT NOT NULL,
      details TEXT
    );

    -- Table to store dense vector embeddings for semantic similarity retrieval
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      model_name TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_chunk_id ON chunk_embeddings(chunk_id);

    -- Table to store decision events linked directly to chunks
    CREATE TABLE IF NOT EXISTS decision_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK(event_type IN ('proposal', 'commitment', 'reversal', 'rejection', 'status_claim', 'issue', 'action')),
      topic TEXT NOT NULL,
      value TEXT,
      actor_name TEXT,
      actor_organization TEXT,
      event_date TEXT,
      exact_quote TEXT NOT NULL,
      confidence REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
      verification_status TEXT NOT NULL CHECK(verification_status IN ('candidate', 'supported', 'superseded', 'contradicted', 'insufficient_evidence')),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_decision_events_chunk_id ON decision_events(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_decision_events_topic ON decision_events(topic);
    CREATE INDEX IF NOT EXISTS idx_decision_events_event_date ON decision_events(event_date);
    CREATE INDEX IF NOT EXISTS idx_decision_events_verification_status ON decision_events(verification_status);

    -- Table to store relationships between decision events
    CREATE TABLE IF NOT EXISTS event_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_event_id INTEGER NOT NULL REFERENCES decision_events(id) ON DELETE CASCADE,
      to_event_id INTEGER NOT NULL REFERENCES decision_events(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL CHECK(relation_type IN ('supports', 'supersedes', 'contradicts', 'follows_up_on', 'lacks_follow_up')),
      explanation TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_event_relations_from_event_id ON event_relations(from_event_id);
    CREATE INDEX IF NOT EXISTS idx_event_relations_to_event_id ON event_relations(to_event_id);

    -- Table to track LLM extraction status per chunk for idempotency and resumability
    CREATE TABLE IF NOT EXISTS chunk_extractions (
      chunk_id INT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      extractor_version TEXT NOT NULL,
      model_name TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      event_count INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunk_extractions_chunk_id ON chunk_extractions(chunk_id);

    -- Table to track durable deletion tombstones for right-to-be-forgotten / person purges
    CREATE TABLE IF NOT EXISTS deletion_tombstones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL CHECK(target_type IN ('person')),
      target_value TEXT NOT NULL,
      normalized_value TEXT NOT NULL UNIQUE,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      details_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_deletion_tombstones_normalized ON deletion_tombstones(normalized_value);

    -- Table to track privacy-preserving LLM usage logs and cost metrics
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

    CREATE INDEX IF NOT EXISTS idx_llm_usage_log_operation ON llm_usage_log(operation);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_log_created_at ON llm_usage_log(created_at);

    -- FTS5 Full-Text Search Virtual Table for fast, ranked keyword retrieval
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      chunk_text,
      tokenize = 'porter unicode61'
    );

    -- Triggers to ensure chunks_fts stays 100% in sync with chunks table
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(chunk_id, chunk_text) VALUES (new.id, new.chunk_text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
      INSERT INTO chunks_fts(chunk_id, chunk_text) VALUES (new.id, new.chunk_text);
    END;
  `);

  const decisionEventsTableInfo = db.prepare("PRAGMA table_info(decision_events)").all();
  const chunkIdColumn = decisionEventsTableInfo.find((col) => col.name === 'chunk_id');
  if (chunkIdColumn && chunkIdColumn.type.toUpperCase() === 'TEXT') {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          -- Backup decision_events into temp table with CAST(chunk_id AS INTEGER)
          CREATE TABLE decision_events_mig_tmp (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL CHECK(event_type IN ('proposal', 'commitment', 'reversal', 'rejection', 'status_claim', 'issue', 'action')),
            topic TEXT NOT NULL,
            value TEXT,
            actor_name TEXT,
            actor_organization TEXT,
            event_date TEXT,
            exact_quote TEXT NOT NULL,
            confidence REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
            verification_status TEXT NOT NULL CHECK(verification_status IN ('candidate', 'supported', 'superseded', 'contradicted', 'insufficient_evidence')),
            created_at TEXT NOT NULL
          );

          INSERT INTO decision_events_mig_tmp (
            id, chunk_id, event_type, topic, value, actor_name, actor_organization,
            event_date, exact_quote, confidence, verification_status, created_at
          )
          SELECT
            id, CAST(chunk_id AS INTEGER), event_type, topic, value, actor_name, actor_organization,
            event_date, exact_quote, confidence, verification_status, created_at
          FROM decision_events;

          -- Backup event_relations into temp table
          CREATE TABLE event_relations_mig_tmp (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_event_id INTEGER NOT NULL REFERENCES decision_events(id) ON DELETE CASCADE,
            to_event_id INTEGER NOT NULL REFERENCES decision_events(id) ON DELETE CASCADE,
            relation_type TEXT NOT NULL CHECK(relation_type IN ('supports', 'supersedes', 'contradicts', 'follows_up_on', 'lacks_follow_up')),
            explanation TEXT,
            created_at TEXT NOT NULL
          );

          INSERT INTO event_relations_mig_tmp (
            id, from_event_id, to_event_id, relation_type, explanation, created_at
          )
          SELECT id, from_event_id, to_event_id, relation_type, explanation, created_at
          FROM event_relations;

          -- Drop legacy tables
          DROP TABLE event_relations;
          DROP TABLE decision_events;

          -- Rename temp tables to active schema
          ALTER TABLE decision_events_mig_tmp RENAME TO decision_events;
          ALTER TABLE event_relations_mig_tmp RENAME TO event_relations;

          -- Recreate indexes
          CREATE INDEX IF NOT EXISTS idx_decision_events_chunk_id ON decision_events(chunk_id);
          CREATE INDEX IF NOT EXISTS idx_decision_events_topic ON decision_events(topic);
          CREATE INDEX IF NOT EXISTS idx_decision_events_event_date ON decision_events(event_date);
          CREATE INDEX IF NOT EXISTS idx_decision_events_verification_status ON decision_events(verification_status);

          CREATE INDEX IF NOT EXISTS idx_event_relations_from_event_id ON event_relations(from_event_id);
          CREATE INDEX IF NOT EXISTS idx_event_relations_to_event_id ON event_relations(to_event_id);
        `);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  const ftsCount = db.prepare('SELECT COUNT(*) as count FROM chunks_fts').get();
  const chunkCount = db.prepare('SELECT COUNT(*) as count FROM chunks').get();
  if (ftsCount.count === 0 && chunkCount.count > 0) {
    db.prepare('INSERT INTO chunks_fts(chunk_id, chunk_text) SELECT id, chunk_text FROM chunks').run();
  }

  return db;
}
