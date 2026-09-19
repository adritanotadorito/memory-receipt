import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase } from './db.js';
import { answerQuestion } from './answer.js';
import { chatCompletion } from './llm.js';
import {
  previewPersonDeletion,
  deletePersonData,
  verifyPersonDeletion,
  getDeletionTombstones,
} from './deletion.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Builds the focused Cytoscape graph payload for an answer's verified receipts and events.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} answerResult
 * @returns {{ nodes: Array<object>, edges: Array<object> }}
 */
export function buildFocusedGraph(db, answerResult) {
  const nodes = [];
  const edges = [];
  const nodeSet = new Set();
  const edgeSet = new Set();

  const receipts = answerResult.receipts || [];
  const citations = answerResult.citations || [];
  const claims = answerResult.claims || [];

  // Map each receipt to its claim currency if cited
  const receiptCurrencyMap = new Map();
  claims.forEach((claim) => {
    const rids = claim.receipt_ids || claim.evidence_ids || [];
    rids.forEach((rid) => {
      receiptCurrencyMap.set(rid.toLowerCase(), claim.currency);
    });
  });

  // Prioritize receipts cited in claims, fallback to top retrieved receipts
  const activeReceipts = citations.length > 0
    ? citations
    : receipts.slice(0, 8);

  const eventIds = [];

  activeReceipts.forEach((r) => {
    const rid = r.receiptId || `event-${r.eventId}`;
    const evId = r.eventId;
    if (evId) eventIds.push(evId);

    const currency = receiptCurrencyMap.get(rid.toLowerCase()) || 'current';
    const eventType = r.eventType || 'decision';
    const topic = r.topic || 'General Decision';
    const quote = r.exactQuote || '';
    const date = r.eventDate || '';
    const actor = r.actorName || '';

    // 1. Event Node
    if (!nodeSet.has(rid)) {
      nodeSet.add(rid);
      nodes.push({
        data: {
          id: rid,
          label: `[${eventType.toUpperCase()}]\n${topic}`,
          nodeType: 'event',
          eventType,
          currency,
          exactQuote: quote,
          eventDate: date,
          actorName: actor,
          sourceLocation: r.sourceLocation,
          topic,
          isCited: receiptCurrencyMap.has(rid.toLowerCase()),
        },
      });
    }

    // 2. Document Node
    const docPath = r.relativePath || (r.sourceLocation ? r.sourceLocation.split(',')[0] : 'document');
    const docId = `doc:${docPath}`;
    const docFilename = r.filename || path.basename(docPath);

    if (!nodeSet.has(docId)) {
      nodeSet.add(docId);
      nodes.push({
        data: {
          id: docId,
          label: `📄 ${docFilename}`,
          nodeType: 'document',
          path: docPath,
          category: r.category || 'unknown',
        },
      });
    }

    // Edge: Event -> Document (from source)
    const docEdgeId = `edge:${rid}->${docId}`;
    if (!edgeSet.has(docEdgeId)) {
      edgeSet.add(docEdgeId);
      edges.push({
        data: {
          id: docEdgeId,
          source: rid,
          target: docId,
          label: 'from source',
          edgeType: 'source',
        },
      });
    }

    // 3. Person / Actor Node
    if (actor && actor.trim()) {
      const actorId = `actor:${actor.trim().toLowerCase()}`;
      if (!nodeSet.has(actorId)) {
        nodeSet.add(actorId);
        nodes.push({
          data: {
            id: actorId,
            label: `👤 ${actor.trim()}`,
            nodeType: 'person',
            name: actor.trim(),
          },
        });
      }

      // Edge: Event -> Actor (attributed to)
      const actorEdgeId = `edge:${rid}->${actorId}`;
      if (!edgeSet.has(actorEdgeId)) {
        edgeSet.add(actorEdgeId);
        edges.push({
          data: {
            id: actorEdgeId,
            source: rid,
            target: actorId,
            label: 'attributed to',
            edgeType: 'attribution',
          },
        });
      }
    }
  });

  // Query relations between these active events from event_relations
  if (eventIds.length > 0) {
    const placeholders = eventIds.map(() => '?').join(',');
    try {
      const relRows = db.prepare(`
        SELECT from_event_id, to_event_id, relation_type, explanation
        FROM event_relations
        WHERE from_event_id IN (${placeholders}) AND to_event_id IN (${placeholders})
      `).all(...eventIds, ...eventIds);

      relRows.forEach((rel, idx) => {
        const sourceNodeId = `event-${rel.from_event_id}`;
        const targetNodeId = `event-${rel.to_event_id}`;
        if (nodeSet.has(sourceNodeId) && nodeSet.has(targetNodeId)) {
          const relEdgeId = `relEdge:${sourceNodeId}->${targetNodeId}:${idx}`;
          if (!edgeSet.has(relEdgeId)) {
            edgeSet.add(relEdgeId);
            edges.push({
              data: {
                id: relEdgeId,
                source: sourceNodeId,
                target: targetNodeId,
                label: rel.relation_type.replace(/_/g, ' '),
                edgeType: 'relation',
                explanation: rel.explanation,
              },
            });
          }
        }
      });
    } catch {}
  }

  return { nodes, edges };
}

/**
 * Creates and configures the Express application.
 *
 * @param {import('better-sqlite3').Database} [db]
 * @param {Function} [llm=chatCompletion]
 * @returns {import('express').Express}
 */
export function createApp(db = initDatabase(), llm = chatCompletion) {
  const app = express();

  app.use(express.json());

  // Serve Cytoscape locally from node_modules (No external CDN)
  app.use('/vendor', express.static(path.join(__dirname, '../node_modules/cytoscape/dist')));

  // Serve frontend assets
  app.use(express.static(path.join(__dirname, '../public')));

  // GET /api/health
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  // POST /api/ask
  app.post('/api/ask', async (req, res) => {
    try {
      const { question, model } = req.body || {};
      if (!question || typeof question !== 'string' || !question.trim()) {
        return res.status(400).json({ ok: false, error: 'Question must be a non-empty string' });
      }

      const answerResult = await answerQuestion(db, question.trim(), llm, { model });
      const graph = buildFocusedGraph(db, answerResult);

      return res.json({
        ok: true,
        data: {
          ...answerResult,
          graph,
        },
      });
    } catch (err) {
      console.error('Server /api/ask error:', err.message);
      return res.status(500).json({
        ok: false,
        error: 'An internal error occurred during question synthesis.',
      });
    }
  });

  // POST /api/deletion/preview
  app.post('/api/deletion/preview', (req, res) => {
    try {
      const { personName } = req.body || {};
      if (!personName || typeof personName !== 'string' || !personName.trim()) {
        return res.status(400).json({ ok: false, error: 'personName must be a non-empty string' });
      }

      const preview = previewPersonDeletion(db, personName.trim());
      return res.json({ ok: true, data: preview });
    } catch (err) {
      console.error('Server /api/deletion/preview error:', err.message);
      return res.status(500).json({ ok: false, error: 'Failed to generate deletion preview.' });
    }
  });

  // POST /api/deletion/confirm
  app.post('/api/deletion/confirm', (req, res) => {
    try {
      const { personName, confirmed } = req.body || {};
      if (!personName || typeof personName !== 'string' || !personName.trim()) {
        return res.status(400).json({ ok: false, error: 'personName must be a non-empty string' });
      }

      if (confirmed !== true) {
        return res.status(400).json({
          ok: false,
          error: 'Permanent deletion requires explicit confirmation { confirmed: true }.',
        });
      }

      const result = deletePersonData(db, personName.trim());
      return res.json({ ok: true, data: result });
    } catch (err) {
      console.error('Server /api/deletion/confirm error:', err.message);
      return res.status(500).json({ ok: false, error: 'Failed to execute person deletion.' });
    }
  });

  // GET /api/deletion/tombstones
  app.get('/api/deletion/tombstones', (req, res) => {
    try {
      const tombstones = getDeletionTombstones(db);
      return res.json({ ok: true, data: tombstones });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'Failed to fetch deletion tombstones.' });
    }
  });

  return app;
}

/**
 * Starts the HTTP server.
 */
export function startServer() {
  const port = process.env.PORT || 3000;
  const dbPath = process.env.DB_PATH || 'data/memory.db';
  const db = initDatabase(dbPath);
  const app = createApp(db, chatCompletion);

  return app.listen(port, () => {
    console.log('\n================================================================');
    console.log('         MEMORY WITH A RECEIPT: LOCAL DEMO WEB SERVER');
    console.log('================================================================');
    console.log(`🚀 Server running at: http://localhost:${port}`);
    console.log(`📁 Database:          ${dbPath}`);
    console.log(`🤖 Model:             ${process.env.OPENAI_MODEL || 'gpt-4.1-mini'}`);
    console.log('================================================================\n');
  });
}

// Auto-start if run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
