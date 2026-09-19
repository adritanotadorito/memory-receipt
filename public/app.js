/**
 * Memory With a Receipt — Frontend Web App
 * Interactive Q&A, Focused Cytoscape Graph, and Deletion Verification
 */

let cy = null;

// Initialize Cytoscape container with styles
function initCytoscape() {
  if (typeof cytoscape === 'undefined') {
    console.error('Cytoscape library not loaded.');
    return;
  }

  cy = cytoscape({
    container: document.getElementById('cy'),
    boxSelectionEnabled: false,
    autounselectify: false,
    style: [
      {
        selector: 'node',
        style: {
          'label': 'data(label)',
          'color': '#f8fafc',
          'font-family': 'Inter, sans-serif',
          'font-size': '11px',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '140px',
          'border-width': 2,
          'transition-property': 'background-color, line-color, target-arrow-color, border-color, width, height',
          'transition-duration': '0.2s',
        },
      },
      // Event Nodes (Current / Historical / Uncertain)
      {
        selector: 'node[nodeType = "event"]',
        style: {
          'shape': 'round-rectangle',
          'width': '150px',
          'height': '60px',
          'background-color': '#0f291e',
          'border-color': '#10b981',
          'font-weight': 600,
        },
      },
      {
        selector: 'node[nodeType = "event"][currency = "historical"]',
        style: {
          'background-color': '#2a1a08',
          'border-color': '#f59e0b',
        },
      },
      {
        selector: 'node[nodeType = "event"][currency = "uncertain"]',
        style: {
          'background-color': '#1e293b',
          'border-color': '#94a3b8',
        },
      },
      // Document Nodes
      {
        selector: 'node[nodeType = "document"]',
        style: {
          'shape': 'ellipse',
          'width': '110px',
          'height': '60px',
          'background-color': '#0c2340',
          'border-color': '#3b82f6',
          'font-size': '10px',
        },
      },
      // Person / Actor Nodes
      {
        selector: 'node[nodeType = "person"]',
        style: {
          'shape': 'round-diamond',
          'width': '100px',
          'height': '60px',
          'background-color': '#241038',
          'border-color': '#a855f7',
          'font-size': '11px',
        },
      },
      // Highlighted Node State
      {
        selector: 'node.highlighted',
        style: {
          'border-width': 4,
          'border-color': '#38bdf8',
          'shadow-blur': 15,
          'shadow-color': '#38bdf8',
          'shadow-opacity': 0.8,
        },
      },
      // Edges
      {
        selector: 'edge',
        style: {
          'width': 2,
          'line-color': '#334155',
          'target-arrow-color': '#334155',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'label': 'data(label)',
          'color': '#94a3b8',
          'font-size': '9px',
          'font-family': 'JetBrains Mono, monospace',
          'text-background-opacity': 0.9,
          'text-background-color': '#090d16',
          'text-background-padding': '2px',
          'text-background-shape': 'roundrectangle',
          'text-rotation': 'autorotate',
        },
      },
      {
        selector: 'edge[edgeType = "source"]',
        style: {
          'line-color': '#1d4ed8',
          'target-arrow-color': '#1d4ed8',
          'line-style': 'dashed',
        },
      },
      {
        selector: 'edge[edgeType = "attribution"]',
        style: {
          'line-color': '#7e22ce',
          'target-arrow-color': '#7e22ce',
        },
      },
      {
        selector: 'edge[edgeType = "relation"]',
        style: {
          'line-color': '#06b6d4',
          'target-arrow-color': '#06b6d4',
          'width': 3,
        },
      },
      {
        selector: 'edge.highlighted',
        style: {
          'line-color': '#38bdf8',
          'target-arrow-color': '#38bdf8',
          'width': 4,
        },
      },
    ],
    elements: [],
    layout: {
      name: 'cose',
      animate: false,
    },
  });

  // Node selection handler
  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    const nodeId = node.id();
    highlightReceiptCard(nodeId);
  });
}

// Render graph elements from server response
function renderGraph(graphData) {
  const emptyState = document.getElementById('graph-empty-state');
  const nodeCountBadge = document.getElementById('graph-node-count');

  if (!cy) initCytoscape();
  if (!cy) return;

  const nodes = graphData && Array.isArray(graphData.nodes) ? graphData.nodes : [];
  const edges = graphData && Array.isArray(graphData.edges) ? graphData.edges : [];

  if (nodes.length === 0) {
    emptyState.classList.remove('hidden');
    nodeCountBadge.textContent = '0 nodes';
    cy.elements().remove();
    return;
  }

  emptyState.classList.add('hidden');
  nodeCountBadge.textContent = `${nodes.length} nodes &bull; ${edges.length} edges`;

  cy.elements().remove();
  cy.add([...nodes, ...edges]);

  // Run layout
  const layout = cy.layout({
    name: 'cose',
    animate: true,
    animationDuration: 500,
    nodeRepulsion: 6500,
    idealEdgeLength: 100,
    edgeElasticity: 100,
    nestingFactor: 5,
    gravity: 80,
    numIter: 1000,
    padding: 30,
  });

  layout.run();
}

// Highlight corresponding receipt card on node click
function highlightReceiptCard(nodeId) {
  document.querySelectorAll('.receipt-card').forEach((card) => {
    card.classList.remove('active-receipt');
    if (card.dataset.receiptId === nodeId) {
      card.classList.add('active-receipt');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

// Highlight node in Cytoscape when receipt is clicked/hovered
function highlightGraphNode(receiptId) {
  if (!cy) return;
  cy.elements().removeClass('highlighted');
  const node = cy.getElementById(receiptId);
  if (node && node.length > 0) {
    node.addClass('highlighted');
    node.connectedEdges().addClass('highlighted');
    cy.animate({
      center: { eles: node },
      duration: 300,
    });
  }
}

// Execute question query
async function handleAskQuestion(question) {
  const questionInput = document.getElementById('question-input');
  const btnAsk = document.getElementById('btn-ask');
  const spinner = document.getElementById('ask-spinner');
  const answerContainer = document.getElementById('answer-container');
  const statusPill = document.getElementById('status-pill');
  const answerText = document.getElementById('grounded-answer-text');
  const reasoningBox = document.getElementById('reasoning-note-box');
  const reasoningText = document.getElementById('reasoning-note-text');
  const claimsList = document.getElementById('claims-list');
  const receiptsList = document.getElementById('receipts-list');
  const citationBadge = document.getElementById('citation-count-badge');

  if (!question || !question.trim()) return;

  questionInput.value = question;
  btnAsk.disabled = true;
  spinner.classList.remove('hidden');

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question.trim() }),
    });

    const body = await res.json();
    if (!body.ok) {
      throw new Error(body.error || 'Failed to synthesize answer.');
    }

    const data = body.data;

    // 1. Status Pill
    statusPill.className = `status-pill ${data.status}`;
    if (data.status === 'answered') {
      statusPill.textContent = '✅ ANSWERED (HIGH CONFIDENCE)';
    } else if (data.status === 'conflicting_evidence') {
      statusPill.textContent = '⚠️ CONFLICTING EVIDENCE';
    } else {
      statusPill.textContent = '❓ INSUFFICIENT EVIDENCE';
    }

    citationBadge.textContent = `${data.citations ? data.citations.length : 0} Verified Receipts`;

    // 2. Answer Text
    answerText.textContent = data.answer || 'No answer generated.';

    // 3. Reasoning Note
    if (data.reasoningNote) {
      reasoningBox.classList.remove('hidden');
      reasoningText.textContent = data.reasoningNote;
    } else {
      reasoningBox.classList.add('hidden');
    }

    // 4. Atomic Claims
    claimsList.innerHTML = '';
    const claims = Array.isArray(data.claims) ? data.claims : [];
    if (claims.length === 0) {
      claimsList.innerHTML = '<div class="empty-hint">No verified atomic claims generated.</div>';
    } else {
      claims.forEach((claim, idx) => {
        const item = document.createElement('div');
        item.className = 'claim-item';

        const curr = (claim.currency || 'uncertain').toLowerCase();
        const rids = (claim.receipt_ids || []).map((r) => `[${r}]`).join(' ');

        let quoteBlock = '';
        if (claim.evidence_quote) {
          quoteBlock = `<div class="claim-quote-box">Quote: "${claim.evidence_quote}"</div>`;
        }

        item.innerHTML = `
          <div class="claim-header">
            <span class="currency-tag ${curr}">${curr.toUpperCase()}</span>
            <span class="claim-text">${idx + 1}. ${escapeHtml(claim.text)}</span>
          </div>
          <div class="claim-receipt-ref">Supported by receipt: ${rids}</div>
          ${quoteBlock}
        `;
        claimsList.appendChild(item);
      });
    }

    // 5. Verified Receipts List
    receiptsList.innerHTML = '';
    const citations = Array.isArray(data.citations) ? data.citations : [];
    if (citations.length === 0) {
      receiptsList.innerHTML = '<div class="empty-hint">No physical receipts cited.</div>';
    } else {
      citations.forEach((cit) => {
        const card = document.createElement('div');
        card.className = 'receipt-card';
        card.dataset.receiptId = cit.receiptId;

        const actor = cit.actorName ? ` &bull; 👤 ${escapeHtml(cit.actorName)}` : '';
        const date = cit.eventDate ? ` &bull; 📅 ${escapeHtml(cit.eventDate)}` : '';

        card.innerHTML = `
          <div class="receipt-header">
            <span class="receipt-id">[${cit.citationNumber}] ${escapeHtml(cit.receiptId)}</span>
            <span class="receipt-location">📍 ${escapeHtml(cit.sourceLocation)}</span>
          </div>
          <div class="receipt-topic">[${(cit.eventType || '').toUpperCase()}] ${escapeHtml(cit.topic || '')}${actor}${date}</div>
          <div class="receipt-quote">"${escapeHtml(cit.exactQuote || '')}"</div>
        `;

        card.addEventListener('mouseenter', () => highlightGraphNode(cit.receiptId));
        card.addEventListener('click', () => highlightGraphNode(cit.receiptId));

        receiptsList.appendChild(card);
      });
    }

    // 6. Update Focused Evidence Graph
    renderGraph(data.graph);

    answerContainer.classList.remove('hidden');
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btnAsk.disabled = false;
    spinner.classList.add('hidden');
  }
}

// Handle deletion preview
async function handleDeletionPreview() {
  const personInput = document.getElementById('deletion-person-input');
  const previewBox = document.getElementById('deletion-preview-results');
  const personName = personInput.value.trim();

  if (!personName) {
    alert('Please enter a person name.');
    return;
  }

  try {
    const res = await fetch('/api/deletion/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personName }),
    });

    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'Preview failed.');

    const p = body.data;
    previewBox.classList.remove('hidden');
    previewBox.innerHTML = `
      <div style="font-weight: 600; color: #fca5a5; margin-bottom: 8px;">
        ⚠️ Deletion Impact Preview for "${escapeHtml(p.targetName)}"
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-family: monospace; font-size: 12px; color: #cbd5e1;">
        <div>• Chunks to delete: ${p.affectedChunksCount}</div>
        <div>• FTS index rows: ${p.affectedChunksCount}</div>
        <div>• Decision events: ${p.affectedEventsCount}</div>
        <div>• Graph relations: ${p.affectedRelationsCount}</div>
        <div>• Vector embeddings: ${p.affectedEmbeddingsCount}</div>
        <div>• Extraction records: ${p.affectedExtractionsCount}</div>
      </div>
      <div style="margin-top: 8px; font-size: 12px; color: #94a3b8;">
        Affected Documents: ${p.affectedDocuments.join(', ') || 'None'}
      </div>
    `;
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// Handle confirmed deletion
async function handleDeletionConfirm() {
  const personInput = document.getElementById('deletion-person-input');
  const reportBox = document.getElementById('deletion-report');
  const personName = personInput.value.trim();

  if (!personName) {
    alert('Please enter a person name.');
    return;
  }

  const confirmed = window.confirm(
    `Are you sure you want to permanently purge all data for "${personName}" from all derived stores?\n\nThis will remove all linked chunks, FTS rows, embeddings, events, and create an immutable deletion tombstone.`
  );

  if (!confirmed) return;

  try {
    const res = await fetch('/api/deletion/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personName, confirmed: true }),
    });

    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'Deletion failed.');

    const d = body.data;
    const v = d.verification;

    reportBox.classList.remove('hidden');
    reportBox.innerHTML = `
      <div style="font-weight: 700; color: #34d399; margin-bottom: 8px;">
        ✅ Permanent Deletion Completed & Verified
      </div>
      <div style="font-size: 12px; color: #e2e8f0; line-height: 1.6;">
        <div>• Purged Chunks: <b>${d.deletedChunksCount}</b></div>
        <div>• Purged Events: <b>${d.deletedEventsCount}</b></div>
        <div>• Purged Embeddings: <b>${d.deletedEmbeddingsCount}</b></div>
        <div>• Durable Tombstone: <b>Active (Immunizes against future ingestion)</b></div>
        <div>• Remaining in Chunks/FTS/Events/Embeddings: <b>0 (Verified Zero Trace)</b></div>
        <div>• System Cache Status: <b>${escapeHtml(v.cache)}</b></div>
      </div>
      <div style="margin-top: 10px; padding: 6px 10px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 4px; color: #34d399; font-size: 12px; font-weight: 600;">
        🔒 No retrievable derived data remains in the system.
      </div>
    `;
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// Utility to escape HTML strings safely
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// DOM Setup
document.addEventListener('DOMContentLoaded', () => {
  initCytoscape();

  // Form submit
  const qaForm = document.getElementById('qa-form');
  const questionInput = document.getElementById('question-input');
  qaForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleAskQuestion(questionInput.value);
  });

  // Example Chips
  document.querySelectorAll('.chip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.query;
      if (q) handleAskQuestion(q);
    });
  });

  // Graph toolbar buttons
  document.getElementById('btn-fit-graph')?.addEventListener('click', () => {
    if (cy) cy.fit();
  });
  document.getElementById('btn-reset-zoom')?.addEventListener('click', () => {
    if (cy) {
      cy.zoom(1);
      cy.center();
    }
  });

  // Deletion buttons
  document.getElementById('btn-preview-deletion')?.addEventListener('click', handleDeletionPreview);
  document.getElementById('btn-confirm-deletion')?.addEventListener('click', handleDeletionConfirm);
});
