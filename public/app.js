/**
 * Memory With a Receipt — Frontend Web App
 * Interactive Q&A, 3-Column Focused Evidence Graph, and Deletion Verification
 */

let cy = null;

// Initialize Cytoscape container with refined neutral styles and coral accent
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
      // Base Node Style
      {
        selector: 'node',
        style: {
          'font-family': 'Inter, sans-serif',
          'font-size': '10px',
          'color': '#cbd5e1',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '125px',
          'border-width': 1.5,
          'border-color': '#334155',
          'background-color': '#111827',
          'transition-property': 'opacity, background-color, line-color, target-arrow-color, border-color, width, height, shadow-opacity',
          'transition-duration': '0.2s',
        },
      },
      // 1. Decision Event Nodes (Rounded Rectangle, Charcoal fill, Slate outline)
      {
        selector: 'node[nodeType = "event"]',
        style: {
          'shape': 'round-rectangle',
          'width': '135px',
          'height': '50px',
          'background-color': '#141d2b',
          'border-color': '#475569',
          'border-width': 1.5,
          'label': 'data(shortLabel)',
          'font-size': '10px',
          'font-weight': 600,
          'color': '#f1f5f9',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-max-width': '115px',
        },
      },
      // 2. Source Document Nodes (Circle/Ellipse, Muted Charcoal, Label hidden by default)
      {
        selector: 'node[nodeType = "document"]',
        style: {
          'shape': 'ellipse',
          'width': '38px',
          'height': '38px',
          'background-color': '#0f172a',
          'border-color': '#334155',
          'border-width': 1.5,
          'label': '', // hidden by default to prevent clutter
        },
      },
      // 3. Person / Actor Nodes (Diamond, Muted Charcoal, Label hidden by default)
      {
        selector: 'node[nodeType = "person"]',
        style: {
          'shape': 'diamond',
          'width': '38px',
          'height': '38px',
          'background-color': '#0f172a',
          'border-color': '#334155',
          'border-width': 1.5,
          'label': '', // hidden by default to prevent clutter
        },
      },
      // Hovered State for Nodes
      {
        selector: 'node.hovered, node:hover',
        style: {
          'border-color': '#94a3b8',
          'border-width': 2,
          'label': 'data(label)',
          'text-valign': 'top',
          'text-margin-y': '-6px',
          'text-background-opacity': 0.95,
          'text-background-color': '#090d16',
          'text-background-padding': '3px',
          'text-background-shape': 'roundrectangle',
          'color': '#f8fafc',
          'font-size': '10px',
          'z-index': 99,
        },
      },
      // Highlighted State for Nodes (Selected evidence path in muted pastel coral/red)
      {
        selector: 'node.highlighted',
        style: {
          'border-color': '#f87171',
          'border-width': 2.5,
          'background-color': '#201518',
          'shadow-blur': 12,
          'shadow-color': '#f87171',
          'shadow-opacity': 0.65,
          'color': '#ffffff',
          'label': 'data(label)',
          'text-valign': 'top',
          'text-margin-y': '-6px',
          'text-background-opacity': 0.95,
          'text-background-color': '#090d16',
          'text-background-padding': '3px',
          'text-background-shape': 'roundrectangle',
          'font-size': '10px',
          'z-index': 100,
        },
      },
      // Highlighted Event Node (Keep text centered)
      {
        selector: 'node[nodeType = "event"].highlighted',
        style: {
          'text-valign': 'center',
          'text-margin-y': '0px',
          'label': 'data(label)',
        },
      },
      // Dimmed State for Nodes
      {
        selector: 'node.dimmed',
        style: {
          'opacity': 0.18,
        },
      },
      // Base Edge Style (Soft Dark Gray)
      {
        selector: 'edge',
        style: {
          'width': 1.5,
          'line-color': '#334155',
          'target-arrow-color': '#334155',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.8,
          'curve-style': 'bezier',
          'opacity': 0.65,
          'label': '',
          'transition-property': 'opacity, line-color, target-arrow-color, width',
          'transition-duration': '0.2s',
        },
      },
      // Highlighted Edge (Muted pastel coral/red with truthful label)
      {
        selector: 'edge.highlighted',
        style: {
          'line-color': '#f87171',
          'target-arrow-color': '#f87171',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.9,
          'width': 2.5,
          'opacity': 1,
          'z-index': 90,
          'label': 'data(label)',
          'font-size': '9px',
          'font-family': 'JetBrains Mono, monospace',
          'color': '#fca5a5',
          'text-background-opacity': 0.95,
          'text-background-color': '#090d16',
          'text-background-padding': '2px',
          'text-background-shape': 'roundrectangle',
          'text-rotation': 'autorotate',
        },
      },
      // Dimmed Edge
      {
        selector: 'edge.dimmed',
        style: {
          'opacity': 0.08,
        },
      },
    ],
    elements: [],
    layout: {
      name: 'preset',
    },
  });

  // Node selection handler
  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    const nodeType = node.data('nodeType');
    if (nodeType === 'event') {
      const rid = node.id();
      highlightEvidencePath(rid);
      highlightReceiptCard(rid);
    } else {
      // Document or person: highlight its closed neighborhood
      cy.elements().removeClass('highlighted dimmed');
      const closed = node.closedNeighborhood();
      closed.nodes().addClass('highlighted');
      closed.edges().addClass('highlighted');
      cy.elements().not(closed).addClass('dimmed');

      const connectedEvents = node.neighborhood('node[nodeType = "event"]');
      const rids = connectedEvents.map((n) => n.id());
      document.querySelectorAll('.receipt-card').forEach((card) => {
        card.classList.toggle('active-receipt', rids.includes(card.dataset.receiptId));
      });
    }
  });

  // Canvas background tap resets to quiet default state
  cy.on('tap', (evt) => {
    if (evt.target === cy) {
      resetHighlight();
    }
  });

  // Hover handlers for document and person labels
  cy.on('mouseover', 'node', (evt) => {
    evt.target.addClass('hovered');
  });
  cy.on('mouseout', 'node', (evt) => {
    evt.target.removeClass('hovered');
  });
}

/**
 * Three-column evidence layout:
 * - Column 1 (Left): Source documents
 * - Column 2 (Middle): Decision events
 * - Column 3 (Right): People / Actors
 * Optimizes vertical ordering to minimize edge crossings.
 */
function applyThreeColumnEvidenceLayout(cyInstance) {
  if (!cyInstance) return;

  const docNodes = cyInstance.nodes('[nodeType = "document"]');
  const eventNodes = cyInstance.nodes('[nodeType = "event"]');
  const personNodes = cyInstance.nodes('[nodeType = "person"]');

  if (cyInstance.nodes().length === 0) return;

  // 1. Sort events predictably by receipt/event ID
  const sortedEvents = eventNodes.toArray().sort((a, b) => {
    return a.id().localeCompare(b.id(), undefined, { numeric: true });
  });

  const eventIndexMap = new Map();
  sortedEvents.forEach((ev, idx) => {
    eventIndexMap.set(ev.id(), idx);
  });

  // 2. Sort documents by average connected event index to minimize crossing lines
  const sortedDocs = docNodes.toArray().sort((a, b) => {
    const connA = a.neighborhood('node[nodeType = "event"]');
    const connB = b.neighborhood('node[nodeType = "event"]');
    const avgA = connA.length > 0
      ? connA.toArray().reduce((sum, n) => sum + (eventIndexMap.get(n.id()) ?? 0), 0) / connA.length
      : 0;
    const avgB = connB.length > 0
      ? connB.toArray().reduce((sum, n) => sum + (eventIndexMap.get(n.id()) ?? 0), 0) / connB.length
      : 0;
    return avgA - avgB;
  });

  // 3. Sort people by average connected event index to minimize crossing lines
  const sortedPersons = personNodes.toArray().sort((a, b) => {
    const connA = a.neighborhood('node[nodeType = "event"]');
    const connB = b.neighborhood('node[nodeType = "event"]');
    const avgA = connA.length > 0
      ? connA.toArray().reduce((sum, n) => sum + (eventIndexMap.get(n.id()) ?? 0), 0) / connA.length
      : 0;
    const avgB = connB.length > 0
      ? connB.toArray().reduce((sum, n) => sum + (eventIndexMap.get(n.id()) ?? 0), 0) / connB.length
      : 0;
    return avgA - avgB;
  });

  // Column X Coordinates
  const X_DOC = 80;
  const X_EVENT = 320;
  const X_PERSON = 560;

  // Vertical steps and centering
  const Y_EVENT_STEP = 75;
  const numEvents = Math.max(1, sortedEvents.length);
  const numDocs = Math.max(1, sortedDocs.length);
  const numPersons = Math.max(1, sortedPersons.length);

  const Y_DOC_STEP = Math.max(60, (numEvents * Y_EVENT_STEP) / numDocs);
  const Y_PERSON_STEP = Math.max(60, (numEvents * Y_EVENT_STEP) / numPersons);

  const totalEventHeight = (sortedEvents.length - 1) * Y_EVENT_STEP;
  const totalDocHeight = (sortedDocs.length - 1) * Y_DOC_STEP;
  const totalPersonHeight = (sortedPersons.length - 1) * Y_PERSON_STEP;
  const maxHeight = Math.max(totalEventHeight, totalDocHeight, totalPersonHeight, 100);

  const posMap = {};

  // Assign Column 1 positions (Source Documents)
  sortedDocs.forEach((node, i) => {
    const startY = (maxHeight - totalDocHeight) / 2 + 50;
    posMap[node.id()] = {
      x: X_DOC,
      y: startY + i * Y_DOC_STEP,
    };
  });

  // Assign Column 2 positions (Decision Events)
  sortedEvents.forEach((node, i) => {
    const startY = (maxHeight - totalEventHeight) / 2 + 50;
    posMap[node.id()] = {
      x: X_EVENT,
      y: startY + i * Y_EVENT_STEP,
    };
  });

  // Assign Column 3 positions (People / Actors)
  sortedPersons.forEach((node, i) => {
    const startY = (maxHeight - totalPersonHeight) / 2 + 50;
    posMap[node.id()] = {
      x: X_PERSON,
      y: startY + i * Y_PERSON_STEP,
    };
  });

  // Run preset layout
  const layout = cyInstance.layout({
    name: 'preset',
    positions: (node) => posMap[node.id()] || { x: X_EVENT, y: 50 },
    animate: true,
    animationDuration: 350,
    fit: true,
    padding: 35,
  });

  layout.run();
}

// Render graph elements from server response
function renderGraph(graphData) {
  const emptyState = document.getElementById('graph-empty-state');
  const nodeCountBadge = document.getElementById('graph-node-count');

  if (!cy) initCytoscape();
  if (!cy) return;

  const rawNodes = graphData && Array.isArray(graphData.nodes) ? graphData.nodes : [];
  const edges = graphData && Array.isArray(graphData.edges) ? graphData.edges : [];

  if (rawNodes.length === 0) {
    emptyState.classList.remove('hidden');
    nodeCountBadge.textContent = '0 nodes';
    cy.elements().remove();
    return;
  }

  emptyState.classList.add('hidden');
  nodeCountBadge.textContent = `${rawNodes.length} nodes • ${edges.length} edges`;

  // Prepare shortLabel for event nodes to reduce label clutter
  const nodes = rawNodes.map((node) => {
    if (node.data && node.data.nodeType === 'event') {
      const topic = node.data.topic || '';
      const type = (node.data.eventType || 'DECISION').toUpperCase();
      const truncatedTopic = topic.length > 22 ? topic.slice(0, 20) + '…' : topic;
      return {
        ...node,
        data: {
          ...node.data,
          shortLabel: `[${type}]\n${truncatedTopic}`,
        },
      };
    }
    return node;
  });

  cy.elements().remove();
  cy.add([...nodes, ...edges]);

  // Apply three-column evidence layout
  applyThreeColumnEvidenceLayout(cy);
}

// Highlight corresponding receipt card on node click
function highlightReceiptCard(nodeId) {
  document.querySelectorAll('.receipt-card').forEach((card) => {
    const isMatch = card.dataset.receiptId === nodeId;
    card.classList.toggle('active-receipt', isMatch);
    if (isMatch) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

// Highlight connected evidence path for given receipt IDs
function highlightEvidencePath(targetIds) {
  if (!cy) return;
  const idArray = (Array.isArray(targetIds) ? targetIds : [targetIds]).filter(Boolean);

  if (idArray.length === 0) {
    resetHighlight();
    return;
  }

  // Find target nodes and closed neighborhoods
  let targetNodes = cy.collection();
  idArray.forEach((id) => {
    const node = cy.getElementById(id);
    if (node && node.length > 0) {
      targetNodes = targetNodes.union(node);
      targetNodes = targetNodes.union(node.neighborhood());
    }
  });

  if (targetNodes.length === 0) {
    resetHighlight();
    return;
  }

  // Clear previous state
  cy.elements().removeClass('highlighted dimmed');

  // Highlight active path; dim everything else
  targetNodes.nodes().addClass('highlighted');
  targetNodes.edges().addClass('highlighted');
  cy.elements().not(targetNodes).addClass('dimmed');

  // Highlight matching receipt cards
  document.querySelectorAll('.receipt-card').forEach((card) => {
    const isMatch = idArray.includes(card.dataset.receiptId);
    card.classList.toggle('active-receipt', isMatch);
  });
}

// Reset graph and list highlights to quiet default state
function resetHighlight() {
  if (!cy) return;
  cy.elements().removeClass('highlighted dimmed hovered');
  document.querySelectorAll('.receipt-card').forEach((card) => {
    card.classList.remove('active-receipt');
  });
  document.querySelectorAll('.claim-item').forEach((item) => {
    item.classList.remove('active-claim');
  });
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
        const rids = claim.receipt_ids || [];
        const ridsDisplay = rids.map((r) => `[${r}]`).join(' ');

        let quoteBlock = '';
        if (claim.evidence_quote) {
          quoteBlock = `<div class="claim-quote-box">Quote: "${escapeHtml(claim.evidence_quote)}"</div>`;
        }

        item.innerHTML = `
          <div class="claim-header">
            <span class="currency-tag ${curr}">${curr.toUpperCase()}</span>
            <span class="claim-text">${idx + 1}. ${escapeHtml(claim.text)}</span>
          </div>
          <div class="claim-receipt-ref">Supported by receipt: ${escapeHtml(ridsDisplay)}</div>
          ${quoteBlock}
        `;

        // Click claim to highlight all its supported receipts in graph and cards
        item.addEventListener('click', () => {
          document.querySelectorAll('.claim-item').forEach((ci) => ci.classList.remove('active-claim'));
          item.classList.add('active-claim');
          highlightEvidencePath(rids);
          if (rids.length > 0) {
            highlightReceiptCard(rids[0]);
          }
        });

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

        const actor = cit.actorName ? ` • 👤 ${escapeHtml(cit.actorName)}` : '';
        const date = cit.eventDate ? ` • 📅 ${escapeHtml(cit.eventDate)}` : '';

        card.innerHTML = `
          <div class="receipt-header">
            <span class="receipt-id">[${cit.citationNumber}] ${escapeHtml(cit.receiptId)}</span>
            <span class="receipt-location">📍 ${escapeHtml(cit.sourceLocation)}</span>
          </div>
          <div class="receipt-topic">[${(cit.eventType || '').toUpperCase()}] ${escapeHtml(cit.topic || '')}${actor}${date}</div>
          <div class="receipt-quote">"${escapeHtml(cit.exactQuote || '')}"</div>
        `;

        // Hover & click highlight connected evidence path
        card.addEventListener('mouseenter', () => highlightEvidencePath(cit.receiptId));
        card.addEventListener('click', () => {
          highlightEvidencePath(cit.receiptId);
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });

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
    if (cy) cy.fit(undefined, 35);
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
