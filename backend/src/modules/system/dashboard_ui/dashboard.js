let maxPoints = 20;
let rawMetrics = [];
let selectedMethod = 'ALL';
let memoryHistory = { labels: [], heap: [], rss: [] };
let routeHistoryMap = new Map();
let systemLogs = [];
let selectedLogLevel = 'ALL';
let openAccordionKeys = new Set();
let cacheEvents = [];
let selectedCacheAction = 'ALL';

// 🛡️ Security Helper: HTML Entity Sanitizer to prevent XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 🔒 Auth Header Helper for Manager Protected Endpoints
function getAuthHeaders() {
  const token =
    localStorage.getItem('accessToken') ||
    sessionStorage.getItem('accessToken');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handleAuthChallenge() {
  const token = prompt('🔒 Access Restricted: Please enter Manager Access Token (JWT):');
  if (token && token.trim()) {
    localStorage.setItem('accessToken', token.trim());
    fetchMetrics();
  }
}

// =========================================================================
// 🎨 Standalone Enterprise Native HTML5 Canvas Engine (0 External Dependencies)
// =========================================================================
function drawNativeChart(canvasId, labels, datasets, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const parent = canvas.parentElement;
  if (parent) {
    canvas.width = parent.clientWidth || 600;
    canvas.height = parent.clientHeight || 140;
  }

  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const padding = { top: 20, right: 25, bottom: 25, left: 45 };

  ctx.clearRect(0, 0, width, height);

  if (!labels || labels.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for real-time telemetry data...', width / 2, height / 2);
    return;
  }

  let allValues = [];
  datasets.forEach((ds) => allValues.push(...ds.data));
  let maxVal = Math.max(...allValues, 1);
  let minVal = Math.min(...allValues, 0);
  if (maxVal === minVal) maxVal += 10;

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'right';

  const gridSteps = 3;
  for (let i = 0; i <= gridSteps; i++) {
    const y = padding.top + (chartHeight / gridSteps) * i;
    const val = Number((maxVal - ((maxVal - minVal) / gridSteps) * i).toFixed(1));

    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillText(val + (options.unit || ''), padding.left - 6, y + 3);
  }

  datasets.forEach((ds) => {
    if (!ds.data || ds.data.length === 0) return;

    const stepX = labels.length > 1 ? chartWidth / (labels.length - 1) : chartWidth;
    const points = ds.data.map((val, idx) => {
      const x = padding.left + (labels.length > 1 ? idx * stepX : chartWidth / 2);
      const y = padding.top + chartHeight - ((val - minVal) / (maxVal - minVal)) * chartHeight;
      return { x, y, val };
    });

    if (ds.fillColor && points.length > 1) {
      const grad = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
      grad.addColorStop(0, ds.fillColor);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.lineTo(points[points.length - 1].x, height - padding.bottom);
      ctx.lineTo(points[0].x, height - padding.bottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = ds.color || '#818cf8';
    ctx.lineWidth = ds.lineWidth || 2;
    if (ds.dash) ctx.setLineDash(ds.dash);
    else ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);

    points.forEach((pt) => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = ds.color || '#818cf8';
      ctx.fill();
    });
  });

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'center';
  const labelStep = Math.max(1, Math.floor(labels.length / 5));
  labels.forEach((label, idx) => {
    if (idx % labelStep === 0 || idx === labels.length - 1) {
      const x = padding.left + (labels.length > 1 ? idx * (chartWidth / (labels.length - 1)) : chartWidth / 2);
      ctx.fillText(label, x, height - 6);
    }
  });
}

function renderMemoryChart() {
  drawNativeChart('memoryChart', memoryHistory.labels, [
    { label: 'Heap Used (MB)', data: memoryHistory.heap, color: '#818cf8', fillColor: 'rgba(129, 140, 248, 0.18)' },
    { label: 'RSS Memory (MB)', data: memoryHistory.rss, color: '#10b981', dash: [4, 4] }
  ], { unit: 'MB' });
}

// =========================================================================
// 🔄 Real-Time Telemetry Fetcher & Log Streamer
// =========================================================================
async function fetchMetrics() {
  try {
    const res = await fetch('/system/status?t=' + Date.now(), {
      headers: { ...getAuthHeaders() },
    });
    if (res.status === 401 || res.status === 403) {
      handleAuthChallenge();
      return;
    }
    const json = await res.json();
    const data = json.data || json;

    if (!data || !data.uptime) return;

    // 1. Top Indicator Cards
    if (document.getElementById('healthScoreVal')) {
      const score = data.healthScore !== undefined ? data.healthScore : 100;
      document.getElementById('healthScoreVal').innerText = score + '%';
      const statusText = score >= 90 ? 'EXCELLENT' : score >= 75 ? 'GOOD' : 'WARNING';
      const statusColor = score >= 90 ? '#34d399' : score >= 75 ? '#fbbf24' : '#f87171';
      document.getElementById('healthScoreStatus').innerHTML = `Status: <strong style="color:${statusColor}">${statusText}</strong>`;
    }

    if (data.trafficSummary) {
      document.getElementById('totalTrafficVal').innerText = data.trafficSummary.totalRequests + ' Hits';
      document.getElementById('successRateVal').innerText = `Success Rate: ${data.trafficSummary.successRatePercent}%`;
    }

    if (data.engine) {
      if (document.getElementById('nodeVer')) document.getElementById('nodeVer').innerText = 'Node.js ' + data.engine.nodeVersion;
      if (document.getElementById('platformVer')) document.getElementById('platformVer').innerText = data.engine.platform + ' (PID: ' + data.engine.pid + ')';
      if (document.getElementById('envVal')) document.getElementById('envVal').innerText = data.engine.env;
    }

    if (data.cpu && document.getElementById('cpuCores')) {
      const modelName = data.cpu.model ? data.cpu.model.split(' ')[0] : 'Processor';
      document.getElementById('cpuCores').innerText = (data.cpu.cores || 1) + ' Cores (' + modelName + ')';
    }

    if (data.uptime && document.getElementById('uptimeVal')) {
      document.getElementById('uptimeVal').innerText = data.uptime.formatted || '--';
    }
    if (data.memory && document.getElementById('heapVal')) {
      document.getElementById('heapVal').innerText = (data.memory.heapUsedMb || '0') + ' MB';
    }
    if (data.memory && document.getElementById('rssVal')) {
      document.getElementById('rssVal').innerText = 'RSS: ' + (data.memory.processRssMb || '0') + ' MB';
    }

    if (document.getElementById('heapProgressBar')) {
      const pct = data.memory ? data.memory.heapPercent : 20;
      document.getElementById('heapProgressBar').style.width = Math.min(100, Math.max(5, pct)) + '%';
    }

    if (data.database && document.getElementById('dbLatencyVal')) {
      document.getElementById('dbLatencyVal').innerText = data.database.latencyMs || '0 ms';
    }

    if (data.queue) {
      document.getElementById('queueActiveVal').innerText = data.queue.active + ' Active';
      document.getElementById('queueSubVal').innerText = `Waiting: ${data.queue.waiting} | Failed: ${data.queue.failed} | Done: ${data.queue.completed}`;
    }

    // 2. Memory Leak Detector
    const timeLabel = new Date().toLocaleTimeString();
    if (data.memory) {
      memoryHistory.labels.push(timeLabel);
      memoryHistory.heap.push(parseFloat(data.memory.heapUsedMb));
      memoryHistory.rss.push(parseFloat(data.memory.processRssMb));

      if (memoryHistory.labels.length > maxPoints) {
        memoryHistory.labels.shift();
        memoryHistory.heap.shift();
        memoryHistory.rss.shift();
      }
      renderMemoryChart();

      const isLeaking = memoryHistory.heap.length >= 10 && memoryHistory.heap.slice(-5).every((v, i, arr) => i === 0 || v > arr[i - 1]);
      const leakBadge = document.getElementById('memLeakStatus');
      if (leakBadge) {
        if (isLeaking) {
          leakBadge.style.background = 'rgba(239, 68, 68, 0.2)';
          leakBadge.style.color = '#f87171';
          leakBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
          leakBadge.innerText = '⚠️ Memory Leak Warning';
        } else {
          leakBadge.style.background = 'rgba(16,185,129,0.15)';
          leakBadge.style.color = '#34d399';
          leakBadge.style.borderColor = 'rgba(16,185,129,0.3)';
          leakBadge.innerText = '🟢 Memory Status: Normal';
        }
      }
    }

    // 3. Render Logs
    if (data.logs && Array.isArray(data.logs)) {
      systemLogs = data.logs;
      renderTerminalLogs();
    }

    // 3.5 Render Redis Cache Telemetry
    if (data.cacheTelemetry) {
      const ct = data.cacheTelemetry;
      if (document.getElementById('redisStatusVal')) {
        document.getElementById('redisStatusVal').innerText = `${ct.hitRatio}% Hit Ratio`;
      }
      if (document.getElementById('redisSubVal')) {
        document.getElementById('redisSubVal').innerText = `Hits: ${ct.hits} | Miss: ${ct.misses} | Sets: ${ct.sets}`;
      }
      if (document.getElementById('cacheHitCount')) document.getElementById('cacheHitCount').innerText = ct.hits;
      if (document.getElementById('cacheMissCount')) document.getElementById('cacheMissCount').innerText = ct.misses;
      if (document.getElementById('cacheSetCount')) document.getElementById('cacheSetCount').innerText = ct.sets;
      if (document.getElementById('cacheDelCount')) document.getElementById('cacheDelCount').innerText = ct.deletions;
      if (document.getElementById('cacheRatioBadge')) {
        document.getElementById('cacheRatioBadge').innerText = `Hit Ratio: ${ct.hitRatio}% (${ct.totalOps} Ops)`;
      }

      cacheEvents = ct.recentEvents || [];
      renderCacheEvents();
    }

    // 4. Update Insights & Routes
    rawMetrics = data.apiMetrics || [];
    updateInsightsPanel(rawMetrics);
    updateRouteHistory(rawMetrics, timeLabel);
    renderAccordionList(rawMetrics);
  } catch (err) {
    console.error('Metrics fetch error:', err);
  }
}

// Terminal Log Renderer
function renderTerminalLogs() {
  const container = document.getElementById('terminalLogs');
  if (!container) return;

  const filtered = systemLogs.filter((l) => selectedLogLevel === 'ALL' || l.level === selectedLogLevel);
  if (filtered.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted); padding:10px;">No logs matching filter [' + selectedLogLevel + '].</div>';
    return;
  }

  container.innerHTML = filtered
    .map(
      (l) =>
        `<div class="log-row log-${escapeHtml(l.level)}">[${escapeHtml(l.time)}] [${escapeHtml(l.level)}] ${escapeHtml(l.message)}</div>`,
    )
    .join('');
}

function filterLogs(level, btnEl) {
  selectedLogLevel = level;
  document.querySelectorAll('.terminal-btn').forEach((b) => {
    if (!b.innerText.includes('Clear')) {
      b.classList.remove('active');
    }
  });
  if (btnEl) btnEl.classList.add('active');
  renderTerminalLogs();
}

function clearTerminalLogs() {
  systemLogs = [];
  renderTerminalLogs();
}

// Redis Cache Live Events Renderer
function renderCacheEvents() {
  const container = document.getElementById('cacheEventsLogs');
  if (!container) return;

  const searchInput = document.getElementById('cacheSearchInput');
  const searchTerm = (searchInput ? searchInput.value : '').toLowerCase().trim();

  const filtered = cacheEvents.filter((e) => {
    const matchAction = selectedCacheAction === 'ALL' || e.action === selectedCacheAction;
    const matchSearch = !searchTerm || e.key.toLowerCase().includes(searchTerm) || (e.detail && e.detail.toLowerCase().includes(searchTerm));
    return matchAction && matchSearch;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted); padding:10px;">No cache events matching filter.</div>';
    return;
  }

  container.innerHTML = filtered
    .map(
      (e) => `
      <div class="cache-row">
        <span class="cache-badge cache-badge-${escapeHtml(e.action)}">${escapeHtml(e.action)}</span>
        <span class="cache-time">[${escapeHtml(e.time)}]</span>
        <span class="cache-key">${escapeHtml(e.key)}</span>
        <span class="cache-detail">${escapeHtml(e.detail || '')}</span>
      </div>`,
    )
    .join('');
}

function filterCacheEvents(action, btnEl) {
  selectedCacheAction = action;
  const container = document.getElementById('cacheFilterButtons');
  if (container) {
    container.querySelectorAll('.terminal-btn').forEach((b) => b.classList.remove('active'));
  }
  if (btnEl) btnEl.classList.add('active');
  renderCacheEvents();
}

// Manual Cache & Queue Actions
async function triggerClearCache() {
  try {
    const res = await fetch('/system/cache/clear', {
      method: 'POST',
      headers: { ...getAuthHeaders() },
    });
    if (res.status === 401 || res.status === 403) {
      handleAuthChallenge();
      return;
    }
    const json = await res.json();
    alert('🧹 Cache Cleared: ' + (json.message || 'System Redis Cache Invalidated'));
    fetchMetrics();
  } catch (err) {
    alert('Failed to clear cache');
  }
}

async function triggerRetryQueue() {
  try {
    const res = await fetch('/system/queue/retry', {
      method: 'POST',
      headers: { ...getAuthHeaders() },
    });
    if (res.status === 401 || res.status === 403) {
      handleAuthChallenge();
      return;
    }
    const json = await res.json();
    alert('🔄 Queue Retried: ' + (json.message || 'BullMQ Jobs Retried'));
    fetchMetrics();
  } catch (err) {
    alert('Failed to retry queue');
  }
}

// API Test Sandbox Modal (Postman in Dashboard)
function openSandboxModal(method, url) {
  document.getElementById('modalMethod').value = method || 'GET';
  document.getElementById('modalUrl').value = url || '/system/status';
  document.getElementById('modalRouteTitle').innerText = `⚡ Sandbox Tester: ${method || 'GET'} ${url || ''}`;
  document.getElementById('modalBody').value = method === 'GET' ? '{}' : '{\n  "key": "value"\n}';
  document.getElementById('modalResponse').innerText = '// Click Send Request to execute endpoint';
  document.getElementById('sandboxModal').classList.add('active');
}

function closeSandboxModal() {
  document.getElementById('sandboxModal').classList.remove('active');
}

async function executeApiTest() {
  const method = document.getElementById('modalMethod').value;
  const url = document.getElementById('modalUrl').value;
  const bodyText = document.getElementById('modalBody').value;
  const responseBox = document.getElementById('modalResponse');
  const statusTag = document.getElementById('testStatusTag');

  statusTag.innerText = '⚡ Testing...';
  statusTag.style.color = '#f59e0b';

  const startTime = Date.now();
  try {
    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (method !== 'GET' && bodyText.trim()) {
      options.body = bodyText;
    }

    const res = await fetch(url, options);
    const latency = Date.now() - startTime;
    const json = await res.json();

    statusTag.innerText = `✅ ${res.status} ${res.statusText} (${latency} ms)`;
    statusTag.style.color = res.status < 400 ? '#34d399' : '#f87171';
    responseBox.innerText = JSON.stringify(json, null, 2);
  } catch (err) {
    statusTag.innerText = '❌ Request Failed';
    statusTag.style.color = '#f87171';
    responseBox.innerText = 'Error: ' + err.message;
  }
}

function updateInsightsPanel(metrics) {
  if (!metrics || metrics.length === 0) return;

  const hitMetrics = metrics.filter((m) => m.totalRequests > 0);
  if (hitMetrics.length === 0) return;

  const sorted = [...hitMetrics].sort((a, b) => a.averageLatencyMs - b.averageLatencyMs);
  const fastest = sorted[0];
  const slowest = sorted[sorted.length - 1];

  const totalErrors = metrics.reduce((sum, m) => sum + m.failedRequests, 0);
  const avgLatencyOverall = Number((hitMetrics.reduce((sum, m) => sum + m.averageLatencyMs, 0) / hitMetrics.length).toFixed(2));

  if (document.getElementById('fastestRouteVal')) {
    document.getElementById('fastestRouteVal').innerText = `${fastest.method} ${fastest.path} (${fastest.averageLatencyMs} ms)`;
  }
  if (document.getElementById('slowestRouteVal')) {
    document.getElementById('slowestRouteVal').innerText = `${slowest.method} ${slowest.path} (${slowest.averageLatencyMs} ms)`;
  }
  if (document.getElementById('p95LatencyVal')) {
    document.getElementById('p95LatencyVal').innerText = `${avgLatencyOverall} ms`;
  }
  if (document.getElementById('totalErrorsVal')) {
    const errorEl = document.getElementById('totalErrorsVal');
    errorEl.innerText = `${totalErrors} Errors`;
    errorEl.style.color = totalErrors > 0 ? 'var(--danger)' : 'var(--success)';
  }
}

function updateRouteHistory(metrics, timeLabel) {
  metrics.forEach((m) => {
    const key = `${m.method}:${m.path}`;
    if (!routeHistoryMap.has(key)) {
      routeHistoryMap.set(key, []);
    }
    const history = routeHistoryMap.get(key);
    history.push({ time: timeLabel, latency: m.averageLatencyMs });
    if (history.length > maxPoints) history.shift();
  });
}

function filterByMethod(method, btnEl) {
  selectedMethod = method;
  document.querySelectorAll('.method-pills .pill').forEach((p) => p.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  renderAccordionList(rawMetrics);
}

function applySorting() {
  renderAccordionList(rawMetrics);
}

function renderAccordionList(metrics) {
  const container = document.getElementById('accordionContainer');
  if (!container) return;

  if (!metrics || metrics.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">No API calls recorded yet. Hit some endpoints in Postman/Swagger!</div>';
    return;
  }

  const filterQuery = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const sortType = document.getElementById('sortSelect')?.value || 'calls';

  let list = metrics.filter((m) => {
    const matchesMethod = selectedMethod === 'ALL' || m.method.toUpperCase() === selectedMethod;
    const matchesSearch = m.path.toLowerCase().includes(filterQuery) || m.method.toLowerCase().includes(filterQuery);
    return matchesMethod && matchesSearch;
  });

  list.sort((a, b) => {
    if (sortType === 'calls') return b.totalRequests - a.totalRequests;
    if (sortType === 'latency') return b.averageLatencyMs - a.averageLatencyMs;
    if (sortType === 'errors') return b.failedRequests - a.failedRequests;
    if (sortType === 'recent') return new Date(b.lastRequestedAt || 0) - new Date(a.lastRequestedAt || 0);
    return 0;
  });

  // 🧹 ALWAYS CLEAR CONTAINER BEFORE RENDERING FILTERED ITEMS
  container.innerHTML = '';

  if (list.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);">No API endpoints match the selected filter [' + selectedMethod + '].</div>';
    return;
  }

  list.forEach((m) => {
    const key = `${m.method}:${m.path}`;
    const safeKey = key.replace(/[^a-zA-Z0-9]/g, '_');

    let latClass = 'lat-fast';
    if (m.averageLatencyMs > 100 && m.averageLatencyMs <= 300) latClass = 'lat-med';
    if (m.averageLatencyMs > 300) latClass = 'lat-slow';

    const itemEl = document.createElement('div');
    itemEl.className = 'accordion-item' + (openAccordionKeys.has(key) ? ' active' : '');
    itemEl.id = `item-${safeKey}`;
    itemEl.setAttribute('data-key', key);

    itemEl.innerHTML = `
      <div class="accordion-header">
        <div class="accordion-left">
          <span class="method method-${m.method}">${m.method}</span>
          <span class="route-path">${m.path}</span>
        </div>
        <div class="accordion-right">
          <button class="btn-ops" style="padding:2px 8px; font-size:11px;" onclick="event.stopPropagation(); openSandboxModal('${m.method}', '${m.path}')">🚀 Test</button>
          <span style="font-size:12px; color:var(--text-muted);">Calls: <strong style="color:#fff;" id="calls-${safeKey}">${m.totalRequests}</strong></span>
          <span class="latency-tag ${latClass}" id="latTag-${safeKey}">⚡ Avg: ${m.averageLatencyMs} ms</span>
          <span class="chevron">▼</span>
        </div>
      </div>

      <div class="accordion-body">
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap:12px; margin-bottom:16px;">
          <div style="background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; border:1px solid var(--card-border);">
            <div style="font-size:11px; color:var(--text-muted);">Success / Error</div>
            <div style="font-size:14px; font-weight:700; color:#34d399; margin-top:2px;" id="succ-${safeKey}">✅ ${m.successfulRequests} / <span style="color:#f87171;">❌ ${m.failedRequests}</span></div>
          </div>
          <div style="background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; border:1px solid var(--card-border);">
            <div style="font-size:11px; color:var(--text-muted);">Last Response Time</div>
            <div style="font-size:14px; font-weight:700; color:#38bdf8; margin-top:2px;" id="lastLat-${safeKey}">⏱️ ${m.lastLatencyMs || 0} ms</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; border:1px solid var(--card-border);">
            <div style="font-size:11px; color:var(--text-muted);">Avg Latency</div>
            <div style="font-size:14px; font-weight:700; color:#818cf8; margin-top:2px;" id="avgLat-${safeKey}">⚡ ${m.averageLatencyMs} ms</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; border:1px solid var(--card-border);">
            <div style="font-size:11px; color:var(--text-muted);">Avg RAM Used</div>
            <div style="font-size:14px; font-weight:700; color:#a5b4fc; margin-top:2px;" id="ram-${safeKey}">🧠 ${m.averageRamMb || '0.05'} MB</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; border:1px solid var(--card-border);">
            <div style="font-size:11px; color:var(--text-muted);">Avg CPU Time</div>
            <div style="font-size:14px; font-weight:700; color:#facc15; margin-top:2px;" id="cpu-${safeKey}">⚙️ ${m.averageCpuMs || '0.20'} ms</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; border:1px solid var(--card-border);">
            <div style="font-size:11px; color:var(--text-muted);">Last Hit Time</div>
            <div style="font-size:12px; font-weight:600; color:#fff; margin-top:4px;" id="lastTime-${safeKey}">${m.lastRequestedAt ? new Date(m.lastRequestedAt).toLocaleTimeString() : '--'}</div>
          </div>
        </div>

        <div style="font-size:12px; font-weight:600; margin-bottom:8px; color:var(--text-muted);">📈 Real-Time Latency Trend (ms):</div>
        <div style="height:140px; width:100%;">
          <canvas id="chart-${safeKey}"></canvas>
        </div>
      </div>
    `;
    container.appendChild(itemEl);

    const header = itemEl.querySelector('.accordion-header');
    if (header) {
      header.onclick = function () {
        itemEl.classList.toggle('active');
        if (itemEl.classList.contains('active')) {
          openAccordionKeys.add(key);
          setTimeout(() => initRouteChart(key, safeKey), 50);
        } else {
          openAccordionKeys.delete(key);
        }
      };
    }
  });

  updateRouteCharts();
}

function initRouteChart(key, safeKey) {
  const history = routeHistoryMap.get(key) || [];
  drawNativeChart(
    `chart-${safeKey}`,
    history.map((h) => h.time),
    [{ label: 'Latency (ms)', data: history.map((h) => h.latency), color: '#818cf8', fillColor: 'rgba(129, 140, 248, 0.18)' }],
    { unit: ' ms' },
  );
}

function updateRouteCharts() {
  document.querySelectorAll('.accordion-item.active').forEach((item) => {
    const key = item.getAttribute('data-key');
    if (key) {
      const safeKey = key.replace(/[^a-zA-Z0-9]/g, '_');
      initRouteChart(key, safeKey);
    }
  });
}

function filterRoutes() {
  renderAccordionList(rawMetrics);
}

function exportMetricsJson() {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(rawMetrics, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', dataStr);
  downloadAnchor.setAttribute('download', `meal_book_api_metrics_${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

// 🌐 Explicitly Bind All Handler Functions to Window Scope
window.filterByMethod = filterByMethod;
window.applySorting = applySorting;
window.filterRoutes = filterRoutes;
window.filterLogs = filterLogs;
window.clearTerminalLogs = clearTerminalLogs;
window.triggerClearCache = triggerClearCache;
window.triggerRetryQueue = triggerRetryQueue;
window.openSandboxModal = openSandboxModal;
window.closeSandboxModal = closeSandboxModal;
window.executeApiTest = executeApiTest;
window.fetchMetrics = fetchMetrics;
window.exportMetricsJson = exportMetricsJson;
window.renderCacheEvents = renderCacheEvents;
window.filterCacheEvents = filterCacheEvents;

// ⚡ 🌐 Direct Professional DOM Event Listener Attachments for ALL Dashboard Buttons
function setupDomEventListeners() {
  // 1. Operations Bar Buttons (.ops-bar .btn-ops)
  document.querySelectorAll('.ops-bar .btn-ops').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const text = e.currentTarget.innerText.trim();
      if (text.includes('Flush')) {
        triggerClearCache();
      } else if (text.includes('Retry')) {
        triggerRetryQueue();
      } else if (text.includes('Sandbox')) {
        openSandboxModal('GET', '/system/status');
      }
    });
  });

  // 2. Header Action Buttons (.header-right .btn-action)
  document.querySelectorAll('.header-right .btn-action').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const text = e.currentTarget.innerText.trim();
      if (text.includes('Refresh')) {
        fetchMetrics();
      } else if (text.includes('Export')) {
        exportMetricsJson();
      }
    });
  });

  // 3. Method Filter Pills (.method-pills .pill)
  document.querySelectorAll('.method-pills .pill').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const method = e.currentTarget.innerText.trim().toUpperCase();
      filterByMethod(method, e.currentTarget);
    });
  });

  // 4. Terminal Log Filter Buttons (.terminal-header .terminal-btn:not(.cache-btn))
  document.querySelectorAll('.terminal-header .terminal-btn:not(.cache-btn)').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const text = e.currentTarget.innerText.trim();
      if (text.includes('Clear')) {
        clearTerminalLogs();
      } else {
        filterLogs(text, e.currentTarget);
      }
    });
  });

  // 4.5 Redis Cache Filter Buttons (#cacheFilterButtons .cache-btn)
  document.querySelectorAll('#cacheFilterButtons .cache-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const text = e.currentTarget.innerText.trim();
      const action = text.includes('HIT') ? 'HIT' : text.includes('MISS') ? 'MISS' : text.includes('SET') ? 'SET' : text.includes('DEL') ? 'DEL' : 'ALL';
      filterCacheEvents(action, e.currentTarget);
    });
  });

  // 5. Search Input & Sort Select
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => filterRoutes());
  }

  const sortSelect = document.getElementById('sortSelect');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => applySorting());
  }

  // 6. Modal Close & Overlay Click
  const modalCloseBtn = document.querySelector('.modal-close');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => closeSandboxModal());
  }

  const sandboxModal = document.getElementById('sandboxModal');
  if (sandboxModal) {
    sandboxModal.addEventListener('click', (e) => {
      if (e.target === sandboxModal) closeSandboxModal();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupDomEventListeners);
} else {
  setupDomEventListeners();
}

// Real-Time SSE Setup
const eventSource = new EventSource('/system/events');

eventSource.onopen = () => {
  const badge = document.getElementById('lastUpdated');
  if (badge) badge.innerText = '🟢 Real-Time SSE Active';
};

eventSource.onerror = () => {
  const badge = document.getElementById('lastUpdated');
  if (badge) badge.innerText = '🟡 Reconnecting SSE Stream...';
};

eventSource.onmessage = (event) => {
  try {
    const apiMetrics = JSON.parse(event.data);
    if (apiMetrics && Array.isArray(apiMetrics)) {
      rawMetrics = apiMetrics;
      const timeLabel = new Date().toLocaleTimeString();
      updateInsightsPanel(rawMetrics);
      updateRouteHistory(rawMetrics, timeLabel);
      renderAccordionList(rawMetrics);
    }
  } catch (err) {}
};

window.addEventListener('resize', () => {
  renderMemoryChart();
  updateRouteCharts();
});

fetchMetrics();
setInterval(fetchMetrics, 15000);
