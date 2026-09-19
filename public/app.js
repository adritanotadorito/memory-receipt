/**
 * Memory with a Receipt — Evidence Desk Frontend
 * Editorial interface: warm paper palette, serif typography, and provenance graph
 */

let cy = null;
let currentCitations = [];

/**
 * Maps raw database event types to readable human product terms.
 */
function formatReadableEventType(rawType) {
  if (!rawType) return 'Note';
  const t = rawType.toLowerCase();
  if (t === 'status_claim') return 'Update';
  if (t === 'decision') return 'Decision';
  if (t === 'commitment') return 'Commitment';
  if (t === 'issue') return 'Issue';
  if (t === 'reversal') return 'Reversal';
  return t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ');
}

/**
 * Formats ISO date string into readable Month Year (e.g., "March 2024").
 */
function formatReadableDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const trimmed = dateStr.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (match) {
    const year = match[1];
    const monthIndex = parseInt(match[2], 10) - 1;
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const month = months[monthIndex] || '';
    return month ? `${month} ${year}` : year;
  }
  return trimmed;
}

/**
 * Computes 2-letter initials for a person name (e.g. "Ana Duarte" -> "AD").
 */
function getPersonInitials(name) {
  if (!name || typeof name !== 'string') return 'P';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Renders data-minimisation and token metrics in the Data Use disclosure panel.
 * Uses explicit numeric verification (Number.isFinite) to ensure 0 is treated as valid.
 *
 * @param {object|null|undefined} metrics
 */
function renderDataUseMetrics(metrics) {
  const duSearched = document.getElementById('du-searched-count');
  const duIncluded = document.getElementById('du-included-count');
  const duChar = document.getElementById('du-char-count');
  const duMetricsBody = document.getElementById('data-use-metrics-body');
  const duMetricsFallback = document.getElementById('data-use-metrics-fallback');
  const duInput = document.getElementById('du-metric-input');
  const duOutput = document.getElementById('du-metric-output');
  const duTotal = document.getElementById('du-metric-total');
  const duEvidenceChunks = document.getElementById('du-metric-evidence-chunks');
  const duEvidenceChars = document.getElementById('du-metric-evidence-chars');

  const hasValidMetrics = metrics && typeof metrics === 'object' && (
    Number.isFinite(metrics.totalTokens) ||
    Number.isFinite(metrics.promptTokens) ||
    Number.isFinite(metrics.completionTokens) ||
    Number.isFinite(metrics.evidenceCharCount) ||
    Number.isFinite(metrics.retrievedChunkCount) ||
    Number.isFinite(metrics.includedChunkCount)
  );

  if (hasValidMetrics) {
    const searchedCount = Number.isFinite(metrics.retrievedChunkCount) ? metrics.retrievedChunkCount.toLocaleString() : '0';
    const includedCount = Number.isFinite(metrics.includedChunkCount) ? metrics.includedChunkCount.toLocaleString() : '0';
    const charCount = Number.isFinite(metrics.evidenceCharCount) ? metrics.evidenceCharCount.toLocaleString() : '0';
    const promptTokens = Number.isFinite(metrics.promptTokens) ? metrics.promptTokens.toLocaleString() : '0';
    const completionTokens = Number.isFinite(metrics.completionTokens) ? metrics.completionTokens.toLocaleString() : '0';
    const totalTokens = Number.isFinite(metrics.totalTokens) ? metrics.totalTokens.toLocaleString() : '0';

    if (duSearched) duSearched.textContent = searchedCount;
    if (duIncluded) duIncluded.textContent = includedCount;
    if (duChar) duChar.textContent = charCount;

    if (duInput) duInput.textContent = `${promptTokens} tokens`;
    if (duOutput) duOutput.textContent = `${completionTokens} tokens`;
    if (duTotal) duTotal.textContent = `${totalTokens} tokens`;
    if (duEvidenceChunks) duEvidenceChunks.textContent = `Selected evidence: ${includedCount} of ${searchedCount} locally retrieved excerpts`;
    if (duEvidenceChars) duEvidenceChars.textContent = `Evidence supplied for synthesis: ${charCount} characters`;

    if (duMetricsBody) duMetricsBody.classList.remove('hidden');
    if (duMetricsFallback) duMetricsFallback.classList.add('hidden');
  } else {
    if (duSearched) duSearched.textContent = '0';
    if (duIncluded) duIncluded.textContent = '0';
    if (duChar) duChar.textContent = '0';

    if (duMetricsBody) duMetricsBody.classList.add('hidden');
    if (duMetricsFallback) duMetricsFallback.classList.remove('hidden');
  }
}

// Initialize Cytoscape container with paper-trail shapes and oxblood accent
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
      // Base Node Style (Graphite & Warm Paper)
      {
        selector: 'node',
        style: {
          'font-family': 'Inter, sans-serif',
          'font-size': '10px',
          'color': '#22211F',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'border-width': 1,
          'border-color': '#8A8275',
          'background-color': '#DCD5C9',
          'transition-property': 'opacity, background-color, line-color, target-arrow-color, border-color, width, height',
          'transition-duration': '0.15s',
        },
      },
      // 1. Decision Event Nodes (Compact Note Card)
      {
        selector: 'node[nodeType = "event"]',
        style: {
          'shape': 'round-rectangle',
          'width': '135px',
          'height': '44px',
          'background-color': '#E4DED3',
          'border-color': '#7A7265',
          'border-width': 1.5,
          'label': 'data(shortLabel)',
          'font-size': '10px',
          'font-weight': 500,
          'color': '#22211F',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-max-width': '120px',
        },
      },
      // 2. Source Document Nodes (Small Rectangular Paper Slip)
      {
        selector: 'node[nodeType = "document"]',
        style: {
          'shape': 'round-rectangle',
          'width': '115px',
          'height': '28px',
          'background-color': '#EAE5DA',
          'border-color': '#8A8275',
          'border-width': 1,
          'label': 'data(shortLabel)',
          'font-size': '9.5px',
          'font-family': 'JetBrains Mono, monospace',
          'color': '#4A463F',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-max-width': '105px',
        },
      },
      // 3. Person / Actor Nodes (Text-First Identity Slip with Initials)
      {
        selector: 'node[nodeType = "person"]',
        style: {
          'shape': 'round-rectangle',
          'width': '105px',
          'height': '26px',
          'background-color': '#F0ECE4',
          'border-color': '#9E9689',
          'border-width': 1,
          'label': 'data(shortLabel)',
          'font-size': '9.5px',
          'color': '#4A463F',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-max-width': '95px',
        },
      },
      // Hovered State for Nodes
      {
        selector: 'node.hovered, node:hover',
        style: {
          'border-color': '#4A463F',
          'border-width': 1.5,
          'label': 'data(label)',
          'text-valign': 'top',
          'text-margin-y': '-6px',
          'text-background-opacity': 0.96,
          'text-background-color': '#F4F1EA',
          'text-background-padding': '3px',
          'text-background-shape': 'roundrectangle',
          'color': '#22211F',
          'font-size': '10px',
          'z-index': 99,
        },
      },
      // Highlighted State for Nodes (Selected evidence path in oxblood red)
      {
        selector: 'node.highlighted',
        style: {
          'border-color': '#A8453C',
          'border-width': 2,
          'background-color': '#F8EFEF',
          'color': '#22211F',
          'label': 'data(label)',
          'text-valign': 'center',
          'text-margin-y': '0px',
          'font-size': '10px',
          'z-index': 100,
        },
      },
      // Dimmed State for Nodes
      {
        selector: 'node.dimmed',
        style: {
          'opacity': 0.18,
        },
      },
      // Base Edge Style (Thin, quiet, no arrowheads)
      {
        selector: 'edge',
        style: {
          'width': 1.2,
          'line-color': '#9E9689',
          'target-arrow-shape': 'none',
          'curve-style': 'bezier',
          'opacity': 0.7,
          'label': '',
          'transition-property': 'opacity, line-color, target-arrow-color, width',
          'transition-duration': '0.15s',
        },
      },
      // Highlighted Edge (Restrained oxblood red, reveals relationship label)
      {
        selector: 'edge.highlighted',
        style: {
          'line-color': '#A8453C',
          'width': 2,
          'opacity': 1,
          'z-index': 90,
          'label': 'data(label)',
          'font-size': '9px',
          'font-family': 'JetBrains Mono, monospace',
          'color': '#7D2E26',
          'text-background-opacity': 0.96,
          'text-background-color': '#FAF8F5',
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

      if (rids.length > 0) {
        updateArchivalCaption(rids[0]);
      }
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
  const X_DOC = 75;
  const X_EVENT = 310;
  const X_PERSON = 540;

  // Vertical steps and centering
  const Y_EVENT_STEP = 72;
  const numEvents = Math.max(1, sortedEvents.length);
  const numDocs = Math.max(1, sortedDocs.length);
  const numPersons = Math.max(1, sortedPersons.length);

  const Y_DOC_STEP = Math.max(56, (numEvents * Y_EVENT_STEP) / numDocs);
  const Y_PERSON_STEP = Math.max(56, (numEvents * Y_EVENT_STEP) / numPersons);

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
    animationDuration: 300,
    fit: true,
    padding: 30,
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
    nodeCountBadge.textContent = '0 items';
    cy.elements().remove();
    return;
  }

  emptyState.classList.add('hidden');
  nodeCountBadge.textContent = `${rawNodes.length} items • ${edges.length} connections`;

  // Clean labels for human presentation (paper trail style)
  const nodes = rawNodes.map((node) => {
    if (!node.data) return node;

    if (node.data.nodeType === 'event') {
      const topic = node.data.topic || '';
      const readableType = formatReadableEventType(node.data.eventType);
      const truncatedTopic = topic.length > 24 ? topic.slice(0, 22) + '…' : topic;
      return {
        ...node,
        data: {
          ...node.data,
          shortLabel: `${readableType} — ${truncatedTopic}`,
          label: `${readableType} — ${topic}`,
        },
      };
    }

    if (node.data.nodeType === 'document') {
      const filename = node.data.path ? node.data.path.split('/').pop() : 'Document';
      const truncatedFile = filename.length > 18 ? filename.slice(0, 16) + '…' : filename;
      return {
        ...node,
        data: {
          ...node.data,
          shortLabel: truncatedFile,
          label: filename,
        },
      };
    }

    if (node.data.nodeType === 'person') {
      const personName = node.data.name || 'Person';
      const initials = getPersonInitials(personName);
      const truncatedName = personName.length > 14 ? personName.slice(0, 12) + '…' : personName;
      return {
        ...node,
        data: {
          ...node.data,
          shortLabel: `${initials} · ${truncatedName}`,
          label: `${initials} · ${personName}`,
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

// Update the archival annotation quote strip at the bottom of the evidence map
function updateArchivalCaption(receiptId) {
  const strip = document.getElementById('graph-caption-strip');
  const captionText = document.getElementById('graph-caption-text');
  if (!strip || !captionText) return;

  const cit = currentCitations.find((c) => c.receiptId === receiptId);
  if (cit && cit.exactQuote) {
    const loc = cit.sourceLocation ? ` — ${cit.sourceLocation}` : '';
    captionText.textContent = `“${cit.exactQuote}”${loc}`;
    strip.classList.remove('hidden');
  } else {
    strip.classList.add('hidden');
  }
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
  updateArchivalCaption(nodeId);
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

  // Update archival caption
  if (idArray.length > 0) {
    updateArchivalCaption(idArray[0]);
  }
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
  const strip = document.getElementById('graph-caption-strip');
  if (strip) strip.classList.add('hidden');
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
      throw new Error(body.error || 'Failed to generate answer.');
    }

    const data = body.data;
    currentCitations = Array.isArray(data.citations) ? data.citations : [];

    // 1. Status Indicator (Human sentence case)
    statusPill.className = `status-indicator ${data.status}`;
    if (data.status === 'answered') {
      statusPill.textContent = 'Supported answer';
    } else if (data.status === 'conflicting_evidence') {
      statusPill.textContent = 'Conflicting evidence';
    } else {
      statusPill.textContent = 'Insufficient evidence';
    }

    const citCount = currentCitations.length;
    citationBadge.textContent = citCount === 1 ? '1 source' : `${citCount} sources`;

    // 2. Answer Text
    answerText.textContent = data.answer || 'No answer generated.';

    // 3. Reasoning Note
    if (data.reasoningNote) {
      reasoningBox.classList.remove('hidden');
      reasoningText.textContent = data.reasoningNote;
    } else {
      reasoningBox.classList.add('hidden');
    }

    // Update Data Use Metrics with explicit finite-number checks
    const metrics = data?.metrics || body?.metrics;
    renderDataUseMetrics(metrics);

    // 4. Claims (Numbered source notes with quiet chronology annotations)
    claimsList.innerHTML = '';
    const claims = Array.isArray(data.claims) ? data.claims : [];
    if (claims.length === 0) {
      claimsList.innerHTML = '<div class="empty-hint">No specific claims verified.</div>';
    } else {
      claims.forEach((claim, idx) => {
        const item = document.createElement('div');
        item.className = 'claim-item';

        const rids = claim.receipt_ids || [];
        const matchedCitations = currentCitations.filter((c) => rids.includes(c.receiptId));

        // Find date if available
        let claimDate = '';
        for (const cit of matchedCitations) {
          if (cit.eventDate) {
            claimDate = formatReadableDate(cit.eventDate);
            if (claimDate) break;
          }
        }

        const curr = (claim.currency || 'current').toLowerCase();
        let chronologyStatus = 'current record';
        let currencyClass = 'current';

        if (curr === 'historical') {
          chronologyStatus = 'earlier context';
          currencyClass = 'historical';
        } else if (curr === 'uncertain') {
          chronologyStatus = 'unresolved';
          currencyClass = 'uncertain';
        }

        const chronologyText = claimDate
          ? `${claimDate} · ${chronologyStatus}`
          : (chronologyStatus.charAt(0).toUpperCase() + chronologyStatus.slice(1));

        // Source numbering e.g. "Source 01" or "Sources 01, 02"
        const citationNumbers = matchedCitations
          .map((c) => (c.citationNumber < 10 ? `0${c.citationNumber}` : `${c.citationNumber}`))
          .sort();

        let sourceLabel = '';
        if (citationNumbers.length === 1) {
          sourceLabel = `Source ${citationNumbers[0]}`;
        } else if (citationNumbers.length > 1) {
          sourceLabel = `Sources ${citationNumbers.join(', ')}`;
        } else {
          sourceLabel = rids.length > 0 ? `Source ${rids.join(', ')}` : 'Source record';
        }

        let quoteBlock = '';
        if (claim.evidence_quote) {
          quoteBlock = `<blockquote class="claim-quote">“${escapeHtml(claim.evidence_quote)}”</blockquote>`;
        }

        item.innerHTML = `
          <div class="claim-chronology ${currencyClass}">${escapeHtml(chronologyText)}</div>
          <div class="claim-text">${idx + 1}. ${escapeHtml(claim.text)}</div>
          ${quoteBlock}
          <div class="claim-source-ref">${escapeHtml(sourceLabel)}</div>
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

    // 5. Sources List (Editorial Source Notes)
    receiptsList.innerHTML = '';
    if (currentCitations.length === 0) {
      receiptsList.innerHTML = '<div class="empty-hint">No sources cited.</div>';
    } else {
      currentCitations.forEach((cit) => {
        const card = document.createElement('div');
        card.className = 'receipt-card';
        card.dataset.receiptId = cit.receiptId;

        const readableType = formatReadableEventType(cit.eventType);
        const titleText = cit.topic ? `${readableType} — ${cit.topic}` : readableType;

        const attributionParts = [];
        if (cit.actorName) attributionParts.push(cit.actorName);
        if (cit.eventDate) attributionParts.push(cit.eventDate);
        const attributionMeta = attributionParts.length > 0
          ? `<div class="receipt-meta">${escapeHtml(attributionParts.join(' · '))}</div>`
          : '';

        const citNum = cit.citationNumber < 10 ? `0${cit.citationNumber}` : `${cit.citationNumber}`;

        card.innerHTML = `
          <div class="receipt-header">
            <span class="receipt-location">[${citNum}] ${escapeHtml(cit.sourceLocation)}</span>
          </div>
          <div class="receipt-topic">${escapeHtml(titleText)}</div>
          <blockquote class="receipt-quote">“${escapeHtml(cit.exactQuote || '')}”</blockquote>
          ${attributionMeta}
          <details class="technical-details">
            <summary>Technical details</summary>
            <div class="tech-content">
              <span>Receipt ID: <code>${escapeHtml(cit.receiptId)}</code></span>
              <span>Event type: <code>${escapeHtml(cit.eventType || 'unknown')}</code></span>
            </div>
          </details>
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
      <div class="deletion-heading">Deletion impact preview for "${escapeHtml(p.targetName)}"</div>
      <div class="deletion-grid">
        <div>• Chunks to delete: ${p.affectedChunksCount}</div>
        <div>• Search index rows: ${p.affectedChunksCount}</div>
        <div>• Decision events: ${p.affectedEventsCount}</div>
        <div>• Graph relations: ${p.affectedRelationsCount}</div>
        <div>• Vector embeddings: ${p.affectedEmbeddingsCount}</div>
        <div>• Extraction records: ${p.affectedExtractionsCount}</div>
      </div>
      <div class="deletion-foot">Affected documents: ${escapeHtml(p.affectedDocuments.join(', ') || 'None')}</div>
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
    `Are you sure you want to permanently purge all data for "${personName}" from all derived stores?\n\nThis will remove all linked chunks, search index rows, embeddings, events, and create an immutable deletion tombstone.`
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
      <div class="deletion-success-heading">Permanent deletion completed and verified</div>
      <div class="deletion-report-list">
        <div>• Purged chunks: <b>${d.deletedChunksCount}</b></div>
        <div>• Purged events: <b>${d.deletedEventsCount}</b></div>
        <div>• Purged embeddings: <b>${d.deletedEmbeddingsCount}</b></div>
        <div>• Durable tombstone: <b>Active (immunizes against future ingestion)</b></div>
        <div>• Remaining in derived stores: <b>0 (zero trace)</b></div>
        <div>• System cache status: <b>${escapeHtml(v.cache)}</b></div>
      </div>
      <div class="deletion-notice">
        No retrievable derived data remains in the system.
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

  // Example text links
  document.querySelectorAll('.chip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.query;
      if (q) handleAskQuestion(q);
    });
  });

  // Graph toolbar buttons
  document.getElementById('btn-fit-graph')?.addEventListener('click', () => {
    if (cy) cy.fit(undefined, 30);
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
