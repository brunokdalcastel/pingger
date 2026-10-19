'use strict';
// ============================================================ estado
const S = {
  state: null, settings: null, meta: null,
  view: { kind: 'home', id: null },
  period: 600, focus: null,          // focus = {start, end} quando o usuário seleciona na timeline
  offset: 0,                         // deslocamento da janela (s) para navegar no histórico
  pinned: {},                        // sid -> Set(index de hop) com timeline extra
  lastVersion: -1, lastNotif: Date.now() / 1000, lastRefresh: 0, busy: false,
  hopsData: null,
};
const PERIODS = [[60, '1 min'], [300, '5 min'], [600, '10 min'], [1800, '30 min'], [3600, '1 h'], [10800, '3 h'],
  [21600, '6 h'], [43200, '12 h'], [86400, '24 h'], [172800, '48 h'], [604800, '7 dias']];
const INTERVALS = [0.5, 1, 2.5, 5, 10, 15, 30, 60, 90, 120, 300, 600, 900, 1800, 3600];

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmt = (v, d = 1) => v == null ? '-' : Number(v).toFixed(d);
const fmtInt = s => s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : `${s / 3600} h`;
const fmtTime = t => new Date(t * 1000).toLocaleTimeString();
const fmtDate = t => t ? new Date(t * 1000).toLocaleString() : '-';

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {} };
  if (opts.body !== undefined) {
    init.body = opts.raw ? opts.body : JSON.stringify(opts.body);
  }
  const r = await fetch('/api/' + path, init);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('login'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || data || r.statusText);
  return data;
}

function toast(msg, bad = false, ms = 4000) {
  const d = document.createElement('div');
  d.className = 'toast' + (bad ? ' bad' : '');
  d.textContent = msg;
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), ms);
}

function latColor(v) {
  if (v == null) return css('--muted');
  if (v >= S.settings.latency_bad) return css('--bad');
  if (v >= S.settings.latency_warn) return css('--warn');
  return css('--good');
}

function download(url) {
  const a = document.createElement('a');
  a.href = url; a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

// ============================================================ janela de tempo
function windowRange() {
  const now = S.state ? S.state.server_time : Date.now() / 1000;
  const end = now - S.offset;
  return { start: end - S.period, end };
}
function statsRange() {
  if (S.focus) return S.focus;
  const n = Number(S.settings.samples_to_include) || 0;
  if (n > 0 && S.offset === 0) return { last_n: n };
  return windowRange();
}
const qs = o => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// ============================================================ inicialização
async function init() {
  [S.settings, S.meta] = await Promise.all([api('settings'), api('meta')]);
  S.period = Number(S.settings.default_period) || 600;
  applyTheme();
  $('#intervalSel').innerHTML = INTERVALS.map(i => `<option value="${i}">${fmtInt(i)}</option>`).join('');
  $('#intervalSel').value = String(S.settings.defaults.interval);
  fillConfigs();
  $('#traceBtn').onclick = startTrace;
  $('#targetInput').addEventListener('keydown', e => { if (e.key === 'Enter') startTrace(); });
  $('#fileBtn').onclick = e => { e.stopPropagation(); fileMenu(e.currentTarget); };
  $('#toolsBtn').onclick = e => { e.stopPropagation(); toolsMenu(e.currentTarget); };
  $('#wsSel').onchange = e => switchWorkspace(e.target.value);
  document.addEventListener('click', () => closeMenu());
  window.addEventListener('resize', () => render(true));
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  await poll();
  const [hk, hid] = location.hash.slice(1).split('/');
  if (hk) go(hk, hid || null);
  else if (S.state.sessions.length) go('session', S.state.sessions[0].id);
  else go('home');
  setInterval(poll, 1000);
  refreshWorkspaces();
  refreshRecent();
}

function applyTheme() {
  const t = S.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function fillConfigs() {
  const names = Object.keys(S.settings.named_configs || {});
  $('#configSel').innerHTML = '<option value="">Config. padrão</option>' + names.map(n => `<option>${esc(n)}</option>`).join('');
}

async function refreshWorkspaces() {
  const ws = await api('workspaces');
  const names = new Set([ws.current, ...Object.keys(ws.all)]);
  $('#wsSel').innerHTML = [...names].map(n => `<option ${n === ws.current ? 'selected' : ''}>${esc(n)}</option>`).join('') +
    '<option value="__new">+ Novo workspace…</option><option value="__save">Salvar como…</option><option value="__manage">Gerenciar…</option>';
}

async function refreshRecent() {
  const saved = await api('sessions/saved');
  $('#recentHosts').innerHTML = [...new Set(saved.map(s => s.host))].slice(0, 30).map(h => `<option value="${esc(h)}">`).join('');
}

// ============================================================ polling
async function poll() {
  try {
    const st = await api('state?since=' + S.lastNotif);
    S.state = st;
    for (const n of st.notifications) {
      S.lastNotif = Math.max(S.lastNotif, n.ts);
      showNotification(n);
    }
    renderNav();
    updateFavicon();
    const now = Date.now();
    if (st.version !== S.lastVersion && now - S.lastRefresh > 900 && !S.busy) {
      S.lastVersion = st.version;
      S.lastRefresh = now;
      refreshView();
    }
  } catch (e) {
    if (e.message !== 'login') console.warn(e);
  }
}

function showNotification(n) {
  toast(`${n.title}\n${n.body}`, true, 8000);
  beep();
  if ('Notification' in window && Notification.permission === 'granted') new Notification(n.title, { body: n.body });
}

function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.25);
  } catch (_) { }
}

let lastFav = '';
function updateFavicon() {
  const alert = S.state.active_alerts.length > 0;
  const key = alert ? 'r' : 'g';
  if (key === lastFav) return;
  lastFav = key;
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const x = c.getContext('2d');
  x.fillStyle = alert ? '#d93b3b' : '#1f7ae0';
  x.beginPath(); x.arc(16, 16, 15, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#fff'; x.lineWidth = 3;
  x.beginPath(); x.moveTo(5, 22); x.lineTo(11, 15); x.lineTo(16, 19); x.lineTo(22, 9); x.lineTo(27, 13); x.stroke();
  $('#favicon').href = c.toDataURL();
  document.title = alert ? '⚠ Pingger — alerta' : 'Pingger';
}

// ============================================================ navegação lateral
function statusClass(s) {
  if (!s.running) return 'paused';
  if (s.last_rtt == null) return s.samples ? 'bad' : '';
  return s.last_rtt >= S.settings.latency_bad ? 'bad' : s.last_rtt >= S.settings.latency_warn ? 'warn' : 'good';
}

function renderNav() {
  const st = S.state, v = S.view;
  const active = new Set(st.active_alerts.map(a => a.session));
  const item = (kind, id, inner) =>
    `<div class="item ${v.kind === kind && (id == null || v.id === id) ? 'active' : ''}" data-kind="${kind}" data-id="${id ?? ''}">${inner}</div>`;
  let h = `<h4>Alvos <button class="small" data-act="new">+</button></h4>`;
  h += st.sessions.map(s => item('session', s.id,
    `<span class="dot ${statusClass(s)}"></span><span class="nm" title="${esc(s.host)}">${active.has(s.id) ? '⚠ ' : ''}${esc(s.name)}</span>` +
    `<span class="val">${s.historical ? 'hist.' : s.last_rtt == null ? (s.samples ? '✕' : '…') : fmt(s.last_rtt, 0) + ' ms'}</span>`)).join('')
    || '<div class="item sub">Nenhum alvo</div>';
  h += `<h4>Resumos <button class="small" data-act="newsum">+</button></h4>`;
  h += st.summaries.map(sm => item('summary', sm.id, `<span class="nm">▦ ${esc(sm.name)}</span><span class="val">${sm.members.length}</span>`)).join('')
    || '<div class="item sub" data-act="newsum">Criar resumo…</div>';
  h += `<h4>Monitoramento</h4>`;
  h += item('alerts', null, `<span class="nm">🔔 Alertas</span><span class="val">${st.active_alerts.length ? st.active_alerts.length + ' ativo(s)' : ''}</span>`);
  h += item('events', null, `<span class="nm">📜 Log de eventos</span>`);
  h += item('saved', null, `<span class="nm">🕘 Sessões salvas</span>`);
  h += item('settings', null, `<span class="nm">⚙ Configurações</span>`);
  const nav = $('#nav');
  if (nav._last === h) return;
  nav._last = h;
  nav.innerHTML = h;
  nav.querySelectorAll('.item[data-kind]').forEach(el => el.onclick = () => go(el.dataset.kind, el.dataset.id || null));
  nav.querySelectorAll('[data-act=new]').forEach(el => el.onclick = e => { e.stopPropagation(); $('#targetInput').focus(); });
  nav.querySelectorAll('[data-act=newsum]').forEach(el => el.onclick = e => { e.stopPropagation(); newSummary(); });
}

function go(kind, id = null) {
  S.view = { kind, id };
  history.replaceState(null, '', '#' + kind + (id ? '/' + id : ''));
  S.focus = null; S.offset = 0; S.hopsData = null;
  renderNav();
  render();
}

function render() {
  const k = S.view.kind;
  const main = $('#main');
  main._tl = null;
  if (k === 'session') {
    if (!S.state.sessions.find(s => s.id === S.view.id)) return go('home');
    main.innerHTML = sessionShell();
    bindSessionShell();
    refreshView();
  } else if (k === 'summary') { main.innerHTML = '<div class="card"><div class="bd">Carregando…</div></div>'; refreshView(); }
  else if (k === 'alerts') renderAlerts();
  else if (k === 'events') renderEvents();
  else if (k === 'saved') renderSaved();
  else if (k === 'settings') renderSettings();
  else renderHome();
}

async function refreshView() {
  if (S.view.kind === 'session') return refreshSession();
  if (S.view.kind === 'summary') return refreshSummary();
}

// ============================================================ início
function renderHome() {
  $('#main').innerHTML = `<div class="empty">
    <h2>Comece um trace</h2>
    <p>Digite um nome ou IP no campo de alvo acima e clique em <b>Tracear</b>.<br>
    Ex.: <a href="#" data-h="8.8.8.8">8.8.8.8</a> · <a href="#" data-h="1.1.1.1">1.1.1.1</a> · <a href="#" data-h="google.com">google.com</a></p>
    <p class="sub">O Pingger envia sondas para cada roteador do caminho e mostra latência, perda, jitter e MOS ao longo do tempo.</p></div>`;
  $('#main').querySelectorAll('[data-h]').forEach(a => a.onclick = e => { e.preventDefault(); $('#targetInput').value = a.dataset.h; startTrace(); });
}

async function startTrace() {
  const host = $('#targetInput').value.trim();
  if (!host) { $('#targetInput').focus(); return; }
  try {
    const out = await api('sessions', {
      body: {
        host, config: $('#configSel').value,
        settings: { interval: Number($('#intervalSel').value), mode: $('#modeSel').value },
      }
    });
    $('#targetInput').value = '';
    await poll();
    go('session', out[0].id);
    refreshRecent();
  } catch (e) { toast('Alvo inválido: ' + e.message, true); }
}

// ============================================================ sessão
function curSession() { return S.state.sessions.find(s => s.id === S.view.id); }

function sessionShell() {
  const s = curSession();
  return `<div class="card">
    <div class="hd">
      <h2 id="sTitle"></h2><span class="sub" id="sSub"></span>
      <div class="spacer"></div>
      <button id="bRun"></button>
      <button id="bOpts">⚙ Opções do alvo</button>
      <button id="bExport">Exportar ▾</button>
      <button id="bClose" class="danger">Fechar</button>
    </div>
    <div class="bd">
      <div class="tlbar" style="margin-bottom:8px">
        <span class="lbl">Período</span>
        <select id="periodSel">${PERIODS.map(([v, l]) => `<option value="${v}" ${v === S.period ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="small" id="bBack" title="Voltar no tempo">◀</button>
        <button class="small" id="bFwd" title="Avançar">▶</button>
        <button class="small" id="bNow">Agora</button>
        <span id="focusBadge"></span>
        <div class="spacer"></div>
        <span class="lbl">Escala</span>
        <select id="scaleSel">${['auto', 50, 100, 200, 300, 500, 1000, 2000].map(v => `<option ${String(S.settings.graph_scale) === String(v) ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <label class="lbl"><input type="checkbox" id="cJitter" ${S.settings.show_jitter_graph ? 'checked' : ''}> Jitter</label>
        <label class="lbl"><input type="checkbox" id="cRoute" ${S.settings.show_route_changes ? 'checked' : ''}> Mudanças de rota</label>
      </div>
      <div class="gridwrap" id="gridwrap"><table class="hops" id="hopTable"></table><canvas id="gridCanvas"></canvas></div>
      <p class="err" id="sErr"></p>
    </div>
  </div>
  <div class="card"><div class="hd"><h2>Linha do tempo</h2><span class="sub">Arraste para focar um período · clique numa linha da grade para fixar a timeline do hop · duplo-clique volta ao tempo atual</span></div>
    <div class="bd" id="timelines"></div></div>`;
}

function bindSessionShell() {
  const sid = S.view.id;
  $('#bRun').onclick = async () => { const s = curSession(); await api(`sessions/${sid}/${s.running ? 'stop' : 'start'}`, { body: {} }); poll(); };
  $('#bOpts').onclick = () => targetOptions(sid);
  $('#bExport').onclick = e => { e.stopPropagation(); exportMenu(e.currentTarget, sid); };
  $('#bClose').onclick = () => closeSession(sid);
  $('#periodSel').onchange = e => { S.period = Number(e.target.value); S.focus = null; refreshView(); };
  $('#bBack').onclick = () => { S.offset += S.period / 2; S.focus = null; refreshView(); };
  $('#bFwd').onclick = () => { S.offset = Math.max(0, S.offset - S.period / 2); S.focus = null; refreshView(); };
  $('#bNow').onclick = () => { S.offset = 0; S.focus = null; refreshView(); };
  $('#scaleSel').onchange = e => { S.settings.graph_scale = e.target.value; api('settings', { body: { graph_scale: e.target.value } }); refreshView(); };
  $('#cJitter').onchange = e => { S.settings.show_jitter_graph = e.target.checked; api('settings', { body: { show_jitter_graph: e.target.checked } }); refreshView(); };
  $('#cRoute').onchange = e => { S.settings.show_route_changes = e.target.checked; api('settings', { body: { show_route_changes: e.target.checked } }); refreshView(); };
}

async function refreshSession() {
  const sid = S.view.id, s = curSession();
  if (!s || !$('#hopTable')) return;
  S.busy = true;
  try {
    $('#sTitle').textContent = s.name;
    $('#sSub').textContent = `${s.host !== s.name ? s.host + ' · ' : ''}${s.ip || 'resolvendo…'} · ${s.samples} amostras · ` +
      `${s.settings.engine.toUpperCase()}${s.settings.engine === 'tcp' || s.settings.engine === 'udp' ? ':' + s.settings.port : ''} · ` +
      `a cada ${fmtInt(s.settings.interval)}${s.route_changes ? ' · ' + s.route_changes + ' mudança(s) de rota' : ''}`;
    $('#bRun').textContent = s.running ? '⏸ Pausar' : '▶ Retomar';
    $('#sErr').textContent = s.error || '';
    const r = statsRange();
    const data = await api(`sessions/${sid}/hops?` + qs(r));
    if (S.view.id !== sid) return;
    S.hopsData = data;
    const fb = $('#focusBadge');
    if (S.focus) fb.innerHTML = `<span class="badge focus">Foco: ${fmtTime(S.focus.start)} – ${fmtTime(S.focus.end)}</span>`;
    else if (S.offset) fb.innerHTML = `<span class="badge focus">Histórico até ${fmtDate(windowRange().end)}</span>`;
    else fb.innerHTML = `<span class="badge live">Ao vivo</span>`;
    renderHopTable(data);
    await renderTimelines(sid, data);
  } catch (e) {
    console.warn(e);
  } finally { S.busy = false; }
}

function graphScale(hops) {
  const v = S.settings.graph_scale;
  if (v && v !== 'auto') return Number(v);
  const mx = Math.max(10, ...hops.map(h => Math.min(h.max ?? 0, (h.avg ?? 0) * 3)));
  const nice = [10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000];
  return nice.find(n => n >= mx * 1.1) || 5000;
}

function renderHopTable(data) {
  const sid = S.view.id, pins = S.pinned[sid] || new Set();
  const rows = data.hops.map(h => {
    const nm = h.name && h.name !== h.ip ? h.name : '';
    return `<tr data-i="${h.index}" class="${pins.has(h.index) ? 'pinned' : ''}">
      <td>${h.hop}</td><td>${h.count}</td><td class="l">${esc(h.ip || '*')}</td><td class="l name" title="${esc(nm)}">${esc(nm)}</td>
      <td>${fmt(h.avg)}</td><td>${fmt(h.min)}</td><td>${fmt(h.cur)}</td><td>${fmt(h.max)}</td>
      <td class="${h.loss_pct > 0 ? 'lossbad' : ''}">${fmt(h.loss_pct)}</td><td>${fmt(h.jitter)}</td><td>${fmt(h.mos, 2)}</td><td class="graph"></td></tr>`;
  }).join('');
  const scale = graphScale(data.hops);
  $('#hopTable').innerHTML = `<thead><tr><th>Hop</th><th title="Amostras">Cont.</th><th class="l">IP</th><th class="l">Nome</th>
    <th>Média</th><th>Mín</th><th>Atual</th><th>Máx</th><th>Perda %</th><th>Jitter</th><th title="Mean Opinion Score (1–4,5)">MOS</th>
    <th class="graph" id="scaleHead"></th></tr></thead><tbody>${rows || '<tr><td colspan="12" class="l sub">Aguardando a primeira amostra…</td></tr>'}</tbody>`;
  $('#hopTable').querySelectorAll('tbody tr[data-i]').forEach(tr => {
    tr.onclick = () => togglePin(sid, Number(tr.dataset.i));
    tr.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); hopMenu(e, sid, data.hops.find(h => h.index === Number(tr.dataset.i))); };
  });
  drawGridOverlay(data.hops, scale);
}

function drawGridOverlay(hops, scale) {
  const wrap = $('#gridwrap'), cv = $('#gridCanvas');
  const first = wrap.querySelector('tbody td.graph');
  const head = $('#scaleHead');
  if (!first) { cv.width = 0; return; }
  const wr = wrap.getBoundingClientRect(), fr = first.getBoundingClientRect(), hr = head.getBoundingClientRect();
  const rowH = fr.height, x0 = fr.left - wr.left + wrap.scrollLeft, w = fr.width, y0 = hr.top - wr.top;
  const h = hr.height + rowH * hops.length;
  const dpr = window.devicePixelRatio || 1;
  cv.style.left = x0 + 'px'; cv.style.top = y0 + 'px'; cv.style.width = w + 'px'; cv.style.height = h + 'px';
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  drawHopGraph(ctx, 0, 0, w, hr.height, rowH, hops, scale);
}

function drawHopGraph(ctx, x, y, w, headH, rowH, hops, scale) {
  const pad = 8, gw = w - pad * 2, X = v => x + pad + Math.min(1, v / scale) * gw;
  ctx.font = '11px Segoe UI, sans-serif'; ctx.textBaseline = 'middle';
  // eixo
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = scale * i / ticks, xx = X(v);
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xx + .5, y + headH); ctx.lineTo(xx + .5, y + headH + rowH * hops.length); ctx.stroke();
    ctx.fillStyle = css('--muted'); ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
    ctx.fillText(i === ticks ? `${Math.round(v)} ms` : Math.round(v), xx, y + headH / 2);
  }
  // faixa por hop
  const pts = [];
  hops.forEach((hp, i) => {
    const cy = y + headH + rowH * i + rowH / 2;
    if (hp.loss_pct > 0) {
      ctx.fillStyle = css('--loss'); ctx.globalAlpha = .85;
      const lw = Math.max(3, gw * Math.min(1, hp.loss_pct / 100));
      ctx.fillRect(x + pad, cy + rowH / 2 - 5, lw, 3);
      ctx.globalAlpha = 1;
    }
    if (hp.avg == null) return;
    ctx.strokeStyle = css('--muted'); ctx.globalAlpha = .55; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(X(hp.min), cy); ctx.lineTo(Math.max(X(hp.max), X(hp.min) + 1), cy); ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineCap = 'butt';
    if (hp.cur != null) { ctx.strokeStyle = css('--text'); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(hp.cur), cy - 6); ctx.lineTo(X(hp.cur), cy + 6); ctx.stroke(); }
    pts.push([X(hp.avg), cy, hp.avg]);
  });
  ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5; ctx.beginPath();
  pts.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.stroke();
  pts.forEach(([px, py, v]) => {
    ctx.fillStyle = latColor(v); ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = css('--panel'); ctx.lineWidth = 1.5; ctx.stroke();
  });
}

function togglePin(sid, i) {
  const set = S.pinned[sid] || (S.pinned[sid] = new Set());
  set.has(i) ? set.delete(i) : set.add(i);
  refreshSession();
}

async function renderTimelines(sid, data) {
  const box = $('#timelines');
  const pins = [...(S.pinned[sid] || [])].sort((a, b) => a - b);
  const list = [{ hop: -1, label: 'Destino (último hop)' }, ...pins.map(i => {
    const h = data.hops.find(x => x.index === i);
    return { hop: i, label: `Hop ${h ? h.hop : i + 1} · ${h ? (h.name && h.name !== h.ip ? h.name : h.ip) : ''}` };
  })];
  const key = list.map(l => l.hop).join(',') + '|' + S.settings.show_jitter_graph;
  if (box._key !== key) {
    box._key = key;
    box.innerHTML = list.map((l, n) => `<div class="timeline" data-hop="${l.hop}">
      <div class="tlhd"><b>${esc(l.label)}</b><span class="sub" data-stat></span><div class="spacer"></div>
      ${l.hop >= 0 ? `<button class="small" data-unpin="${l.hop}">✕</button>` : ''}</div>
      <canvas height="${l.hop < 0 ? 150 : 110}"></canvas>
      ${S.settings.show_jitter_graph ? '<canvas class="jit" height="60"></canvas>' : ''}</div>`).join('');
    box.querySelectorAll('[data-unpin]').forEach(b => b.onclick = () => togglePin(sid, Number(b.dataset.unpin)));
    box.querySelectorAll('.timeline canvas:not(.jit)').forEach(cv => bindFocusDrag(cv));
  }
  const { start, end } = windowRange();
  await Promise.all([...box.querySelectorAll('.timeline')].map(async el => {
    const cv = el.querySelector('canvas:not(.jit)');
    const w = Math.max(100, Math.floor(cv.clientWidth));
    const tl = await api(`sessions/${sid}/timeline?` + qs({ hop: el.dataset.hop, start, end, buckets: Math.min(w, 1500) }));
    cv._tl = tl;
    drawTimeline(cv, tl);
    const jc = el.querySelector('canvas.jit');
    if (jc) drawJitter(jc, tl);
    const ok = tl.buckets.filter(b => b[1] != null), n = tl.buckets.reduce((a, b) => a + b[0], 0);
    const lost = tl.buckets.reduce((a, b) => a + (b[4] ? b[0] * b[4] / 100 : 0), 0);
    const avg = ok.length ? ok.reduce((a, b) => a + b[1] * (b[0] - (b[4] || 0) * b[0] / 100), 0) / Math.max(1, n - lost) : null;
    el.querySelector('[data-stat]').textContent = `${n} amostras · média ${fmt(avg)} ms · perda ${n ? fmt(lost * 100 / n) : '-'}% · ${fmtTime(start)} – ${fmtTime(end)}`;
  }));
}

function sizeCanvas(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = Number(cv.getAttribute('height'));
  cv.style.height = h + 'px';
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}

function drawTimeline(cv, tl, ctxOverride) {
  const [ctx, w, h] = ctxOverride || sizeCanvas(cv);
  const mini = h < 60;
  const L = mini ? 2 : 44, T = mini ? 2 : 6, B = mini ? 2 : 18, R = mini ? 2 : 6, pw = w - L - R, ph = h - T - B;
  const bs = tl.buckets, n = bs.length;
  ctx.fillStyle = css('--panel2'); ctx.fillRect(0, 0, w, h);
  let scale = S.settings.graph_scale;
  if (!scale || scale === 'auto') {
    const vals = bs.map(b => b[1]).filter(v => v != null).sort((a, b) => a - b);
    const p95 = vals.length ? vals[Math.floor(vals.length * .95)] : 50;
    scale = [10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 2000, 5000].find(x => x >= p95 * 1.3) || 5000;
  } else scale = Number(scale);
  const Y = v => T + ph - Math.min(1, v / scale) * ph;
  ctx.font = '10px Segoe UI, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4 && !mini; i++) {
    const v = scale * i / 4, yy = Y(v);
    ctx.strokeStyle = css('--grid'); ctx.beginPath(); ctx.moveTo(L, yy + .5); ctx.lineTo(w - R, yy + .5); ctx.stroke();
    ctx.fillStyle = css('--muted'); ctx.fillText(Math.round(v) + (i === 4 ? ' ms' : ''), L - 4, yy);
  }
  const bw = pw / n;
  // perda (topo), escala configurável
  const lossScale = Number(S.settings.loss_scale) || 30;
  bs.forEach((b, i) => {
    if (!b[0]) return;
    const x = L + i * bw;
    if (b[3] != null) { ctx.fillStyle = latColor(b[1]); ctx.globalAlpha = .25; ctx.fillRect(x, Y(b[3]), Math.max(1, bw), Y(b[2]) - Y(b[3]) + 1); ctx.globalAlpha = 1; }
    if (b[1] != null) { ctx.fillStyle = latColor(b[1]); ctx.fillRect(x, Y(b[1]), Math.max(1, bw), T + ph - Y(b[1])); }
    if (b[4] > 0) {
      ctx.fillStyle = css('--loss');
      const lh = Math.max(3, Math.min(1, b[4] / lossScale) * ph);
      ctx.fillRect(x, T, Math.max(1, bw), lh);
    }
  });
  // mudanças de rota
  if (S.settings.show_route_changes) {
    ctx.strokeStyle = css('--route'); ctx.setLineDash([3, 3]);
    tl.route_changes.forEach(t => {
      const x = L + (t - tl.start) / (tl.end - tl.start) * pw;
      ctx.beginPath(); ctx.moveTo(x + .5, T); ctx.lineTo(x + .5, T + ph); ctx.stroke();
    });
    ctx.setLineDash([]);
  }
  // eixo do tempo
  ctx.fillStyle = css('--muted'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const labels = mini ? -1 : Math.max(2, Math.floor(pw / 110));
  for (let i = 0; i <= labels; i++) {
    const t = tl.start + (tl.end - tl.start) * i / labels;
    const span = tl.end - tl.start;
    const d = new Date(t * 1000);
    const txt = span > 86400 ? d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString(undefined, span > 1800 ? { hour: '2-digit', minute: '2-digit' } : undefined);
    ctx.textAlign = i === 0 ? 'left' : i === labels ? 'right' : 'center';
    ctx.fillText(txt, L + pw * i / labels, T + ph + 4);
  }
  // foco
  if (S.focus) {
    const fx0 = L + (S.focus.start - tl.start) / (tl.end - tl.start) * pw, fx1 = L + (S.focus.end - tl.start) / (tl.end - tl.start) * pw;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(L, T, Math.max(0, fx0 - L), ph); ctx.fillRect(fx1, T, Math.max(0, L + pw - fx1), ph);
    ctx.strokeStyle = css('--warn'); ctx.strokeRect(fx0, T, fx1 - fx0, ph);
  }
  if (cv) cv._geom = { L, pw };
}

function drawJitter(cv, tl) {
  const [ctx, w, h] = sizeCanvas(cv);
  const L = 44, T = 4, B = 4, R = 6, pw = w - L - R, ph = h - T - B;
  const target = Number(S.settings.jitter_target) || 30;
  const mx = Math.max(target * 1.5, ...tl.buckets.map(b => b[5] || 0));
  const Y = v => T + ph - Math.min(1, v / mx) * ph;
  ctx.fillStyle = css('--panel2'); ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = css('--muted'); ctx.font = '10px Segoe UI'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText('jitter', L - 4, T + 6); ctx.fillText(Math.round(mx) + ' ms', L - 4, T + ph - 6);
  const bw = pw / tl.buckets.length;
  tl.buckets.forEach((b, i) => {
    if (b[5] == null) return;
    ctx.fillStyle = b[5] > target ? css('--bad') : css('--accent');
    ctx.fillRect(L + i * bw, Y(b[5]), Math.max(1, bw), T + ph - Y(b[5]));
  });
  ctx.strokeStyle = css('--warn'); ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(L, Y(target)); ctx.lineTo(L + pw, Y(target)); ctx.stroke(); ctx.setLineDash([]);
}

function bindFocusDrag(cv) {
  let x0 = null;
  const toT = x => {
    const tl = cv._tl, g = cv._geom;
    return tl.start + Math.max(0, Math.min(1, (x - g.L) / g.pw)) * (tl.end - tl.start);
  };
  cv.onmousedown = e => { if (!cv._tl) return; x0 = e.offsetX; };
  cv.onmousemove = e => {
    if (x0 == null) return;
    const a = toT(Math.min(x0, e.offsetX)), b = toT(Math.max(x0, e.offsetX));
    if (b - a >= 1) { S.focus = { start: a, end: b }; drawTimeline(cv, cv._tl); }
  };
  cv.onmouseup = e => {
    if (x0 == null) return;
    const dx = Math.abs(e.offsetX - x0); x0 = null;
    if (dx < 3) {   // clique simples: foca 1 bucket ao redor
      const t = toT(e.offsetX), span = (cv._tl.end - cv._tl.start) / 60;
      S.focus = { start: t - span / 2, end: t + span / 2 };
    }
    refreshSession();
  };
  cv.onmouseleave = () => { x0 = null; };
  cv.ondblclick = () => { S.focus = null; S.offset = 0; refreshSession(); };
  cv.onwheel = e => {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      S.offset = Math.max(0, S.offset + Math.sign(e.deltaY || e.deltaX) * S.period / 10);
    } else {
      const i = PERIODS.findIndex(p => p[0] === S.period);
      const ni = Math.max(0, Math.min(PERIODS.length - 1, i + (e.deltaY > 0 ? 1 : -1)));
      S.period = PERIODS[ni][0]; $('#periodSel').value = S.period;
    }
    S.focus = null; refreshSession();
  };
}

// ============================================================ menus
function closeMenu() { document.querySelectorAll('.menu').forEach(m => m.remove()); }
function menu(x, y, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  items.forEach(it => {
    if (it === '-') { m.appendChild(document.createElement('hr')); return; }
    const d = document.createElement('div');
    d.textContent = it[0];
    d.onclick = e => { e.stopPropagation(); closeMenu(); it[1](); };
    m.appendChild(d);
  });
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
const menuAt = (el, items) => { const r = el.getBoundingClientRect(); menu(r.left, r.bottom + 4, items); };

function hopMenu(e, sid, h) {
  if (!h) return;
  const copy = t => navigator.clipboard.writeText(t).then(() => toast('Copiado: ' + t));
  menu(e.clientX, e.clientY, [
    [`Fixar/soltar timeline do hop ${h.hop}`, () => togglePin(sid, h.index)],
    ['Copiar IP', () => copy(h.ip)],
    ['Copiar nome', () => copy(h.name || h.ip)],
    '-',
    ['Whois / bloco IP…', () => whois(h.ip)],
    ['Consulta DNS…', () => dnsLookup(h.name && h.name !== h.ip ? h.name : h.ip)],
    '-',
    [`Tracear só este hop (${h.hop})`, async () => { await api(`sessions/${sid}`, { body: { mode: 'hop', hop: h.hop } }); toast('Modo: só o hop ' + h.hop); }],
    ['Novo alvo com este IP', async () => { const o = await api('sessions', { body: { host: h.ip } }); await poll(); go('session', o[0].id); }],
    ['Criar alerta para este hop…', () => editAlert({ name: `Hop ${h.hop} (${h.ip})`, applies_to: [sid], condition: { hop: String(h.hop) } })],
  ]);
}

function fileMenu(el) {
  menuAt(el, [
    ['Importar sessão (.pgr)…', () => pickFile('.pgr,.json', async f => {
      const s = await api('import', { body: await f.arrayBuffer(), raw: true }); await poll(); go('session', s.id); toast('Sessão importada');
    })],
    ['Importar lista de alvos…', () => pickFile('.txt,.csv', async f => {
      const out = await api('targets/import', { body: await f.text(), raw: true }); await poll(); toast(`${out.length} alvo(s) adicionados`);
    })],
    ['Exportar lista de alvos', () => download('/api/targets/export')],
    '-',
    ['Salvar workspace', () => api('workspaces', { body: {} }).then(() => toast('Workspace salvo'))],
    ['Sessões salvas…', () => go('saved')],
    '-',
    ['Configurações…', () => go('settings')],
  ]);
}

function toolsMenu(el) {
  menuAt(el, [
    ['Whois / bloco IP…', () => { const ip = prompt('IP para consulta (RDAP):'); if (ip) whois(ip.trim()); }],
    ['Consulta DNS…', () => { const h = prompt('Nome ou IP:'); if (h) dnsLookup(h.trim()); }],
    '-',
    ['Novo resumo…', newSummary],
    ['Alertas…', () => go('alerts')],
    ['Log de eventos', () => go('events')],
    '-',
    ['Tema claro', () => setTheme('light')], ['Tema escuro', () => setTheme('dark')], ['Tema do sistema', () => setTheme('auto')],
  ]);
}
function setTheme(t) { S.settings.theme = t; applyTheme(); api('settings', { body: { theme: t } }); render(); }

function exportMenu(el, sid) {
  const r = statsRange(), range = S.focus || (S.offset ? windowRange() : {});
  menuAt(el, [
    ['CSV — 1 linha por hop × amostra (longo)', () => download(`/api/sessions/${sid}/export.csv?` + qs({ ...range, layout: 'long' }))],
    ['CSV — 1 linha por amostra, colunas por hop (largo)', () => download(`/api/sessions/${sid}/export.csv?` + qs({ ...range, layout: 'wide' }))],
    ['Sessão Pingger (.pgr)', () => download(`/api/sessions/${sid}/export.pgr?` + qs(range))],
    '-',
    ['Copiar estatísticas como texto', async () => { await navigator.clipboard.writeText(await api(`sessions/${sid}/text?` + qs(r))); toast('Estatísticas copiadas'); }],
    ['Copiar como imagem', () => composeImage(sid).then(c => c.toBlob(b => navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).then(() => toast('Imagem copiada')))) ],
    ['Salvar imagem (PNG)', () => composeImage(sid).then(c => { const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `pingger-${curSession().host}-${Date.now()}.png`; a.click(); })],
    '-',
    ['Zerar dados desta sessão', async () => { if (confirm('Apagar todas as amostras desta sessão?')) { await api(`sessions/${sid}/reset`, { body: {} }); refreshSession(); } }],
  ]);
}

function pickFile(accept, cb) {
  const inp = $('#fileInput');
  inp.accept = accept; inp.value = '';
  inp.onchange = () => inp.files[0] && cb(inp.files[0]).catch(e => toast(e.message, true));
  inp.click();
}

async function composeImage(sid) {
  const s = curSession(), data = S.hopsData, scale = graphScale(data.hops);
  const W = 1200, rowH = 22, headH = 24, titleH = 40;
  const tls = [...document.querySelectorAll('#timelines .timeline canvas')];
  const tlH = tls.reduce((a, c) => a + c.clientHeight * (W - 20) / c.clientWidth + 26, 0);
  const H = titleH + headH + rowH * data.hops.length + 20 + tlH + 24;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = css('--panel'); x.fillRect(0, 0, W, H);
  x.fillStyle = css('--text'); x.font = 'bold 16px Segoe UI'; x.textBaseline = 'middle';
  x.fillText(`${s.name} (${s.ip}) — ${data.samples} amostras`, 10, 20);
  x.font = '12px Segoe UI'; x.fillStyle = css('--muted');
  x.fillText(`${fmtDate(data.start)} – ${fmtDate(data.end)}`, 10, 36);
  const cols = [['Hop', 36], ['Perda%', 56], ['IP', 130], ['Nome', 230], ['Média', 56], ['Mín', 50], ['Atual', 50], ['Máx', 56], ['Jitter', 50], ['MOS', 44]];
  let cx = 10, y = titleH;
  x.font = 'bold 11px Segoe UI';
  cols.forEach(([n, w]) => { x.fillText(n, cx, y + headH / 2); cx += w; });
  x.font = '11px Segoe UI'; x.fillStyle = css('--text');
  data.hops.forEach((h, i) => {
    const yy = y + headH + rowH * i + rowH / 2;
    const vals = [h.hop, fmt(h.loss_pct), h.ip || '*', (h.name && h.name !== h.ip ? h.name : '').slice(0, 38), fmt(h.avg), fmt(h.min), fmt(h.cur), fmt(h.max), fmt(h.jitter), fmt(h.mos, 2)];
    let xx = 10;
    vals.forEach((v, k) => { x.fillStyle = k === 1 && h.loss_pct > 0 ? css('--bad') : css('--text'); x.fillText(String(v), xx, yy); xx += cols[k][1]; });
  });
  drawHopGraph(x, cx + 4, y, W - cx - 14, headH, rowH, data.hops, scale);
  y += headH + rowH * data.hops.length + 20;
  for (const cv of tls) {
    const h = cv.clientHeight * (W - 20) / cv.clientWidth;
    const label = cv.closest('.timeline').querySelector('b')?.textContent || '';
    x.fillStyle = css('--text'); x.font = 'bold 12px Segoe UI'; x.fillText(label, 10, y + 10);
    x.drawImage(cv, 10, y + 20, W - 20, h);
    y += h + 26;
  }
  x.fillStyle = css('--muted'); x.font = '10px Segoe UI'; x.textAlign = 'right';
  x.fillText('Gerado pelo Pingger · ' + new Date().toLocaleString(), W - 10, H - 10);
  return c;
}

// ============================================================ ferramentas
function modal(title, html, buttons = [['Fechar', null]]) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><div class="mbody">${html}</div><div class="foot"></div></div>`;
  const foot = bg.querySelector('.foot');
  const close = () => bg.remove();
  buttons.forEach(([label, fn, cls]) => {
    const b = document.createElement('button');
    b.textContent = label; if (cls) b.className = cls;
    b.onclick = async () => { try { if (fn && (await fn(bg)) === false) return; close(); } catch (e) { toast(e.message, true); } };
    foot.appendChild(b);
  });
  bg.onclick = e => { if (e.target === bg) close(); };
  document.body.appendChild(bg);
  return bg;
}

async function whois(ip) {
  const m = modal('Whois — ' + ip, '<p class="sub">Consultando RDAP…</p>');
  try {
    const w = await api('whois?ip=' + encodeURIComponent(ip));
    m.querySelector('.mbody').innerHTML = `<table class="list">
      <tr><th>Rede</th><td>${esc(w.name)} (${esc(w.handle)})</td></tr>
      <tr><th>Faixa</th><td>${esc(w.start)} – ${esc(w.end)} ${w.cidr.map(esc).join(', ')}</td></tr>
      <tr><th>País</th><td>${esc(w.country || '-')}</td></tr><tr><th>Tipo</th><td>${esc(w.type || '-')}</td></tr>
      ${w.entities.map(e => `<tr><th>${esc(e.roles.join(', '))}</th><td>${esc(e.name)} ${e.email ? '&lt;' + esc(e.email) + '&gt;' : ''} <span class="sub">${esc(e.handle || '')}</span></td></tr>`).join('')}
      ${w.remarks.map(r => `<tr><th>Obs.</th><td>${esc(r)}</td></tr>`).join('')}
      <tr><th>Fonte</th><td>${esc(w.source)}</td></tr></table>`;
  } catch (e) { m.querySelector('.mbody').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

async function dnsLookup(host) {
  const m = modal('DNS — ' + host, '<p class="sub">Consultando…</p>');
  const d = await api('dns?host=' + encodeURIComponent(host));
  m.querySelector('.mbody').innerHTML = `<table class="list"><tr><th>Endereços</th><td>${d.addresses.map(esc).join('<br>') || '-'}</td></tr>
    <tr><th>Reverso</th><td>${esc(d.reverse || '-')}</td></tr>${d.error ? `<tr><th>Erro</th><td class="err">${esc(d.error)}</td></tr>` : ''}</table>`;
}

async function closeSession(sid) {
  const s = S.state.sessions.find(x => x.id === sid);
  const m = modal('Fechar ' + s.name, `<p>${s.samples} amostras coletadas. O que fazer com os dados?</p>`, [
    ['Cancelar', null],
    ['Descartar', async () => { await api(`sessions/${sid}?discard=1`, { method: 'DELETE' }); after(); }, 'danger'],
    ['Manter (salvo)', async () => { await api(`sessions/${sid}`, { method: 'DELETE' }); after(); }, 'primary'],
  ]);
  async function after() { await poll(); const n = S.state.sessions[0]; n ? go('session', n.id) : go('home'); }
}

// ============================================================ opções do alvo
function field(label, key, obj, type = 'text', opts = null, hint = '') {
  const v = obj[key];
  let input;
  if (opts) input = `<select data-k="${key}">${opts.map(o => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`; }).join('')}</select>`;
  else if (type === 'checkbox') input = `<input type="checkbox" data-k="${key}" ${v ? 'checked' : ''}>`;
  else if (type === 'textarea') input = `<textarea data-k="${key}" rows="6">${esc(typeof v === 'object' ? JSON.stringify(v, null, 2) : v)}</textarea>`;
  else input = `<input type="${type}" data-k="${key}" value="${esc(v ?? '')}" step="any">`;
  return `<label>${esc(label)}</label><div>${input}${hint ? `<div class="sub">${hint}</div>` : ''}</div>`;
}
function readFields(root, base = {}) {
  const out = {};
  root.querySelectorAll('[data-k]').forEach(el => {
    const k = el.dataset.k, old = base[k];
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.tagName === 'TEXTAREA' && typeof old === 'object') v = JSON.parse(v || '{}');
    else if (typeof old === 'number' && v !== '' && !isNaN(v)) v = Number(v);
    out[k] = v;
  });
  return out;
}

function targetOptions(sid) {
  const s = S.state.sessions.find(x => x.id === sid), st = { ...s.settings, name: s.name };
  const html = `<div class="form">
    ${field('Nome de exibição', 'name', st)}
    ${field('Intervalo (s)', 'interval', st, 'number', INTERVALS.map(i => [i, fmtInt(i)]))}
    ${field('Tipo de pacote', 'engine', st, 'text', [['icmp', 'ICMP (padrão)'], ['tcp', 'TCP (handshake, só destino)'], ['udp', 'UDP (só destino)'], ['remote', 'Via agente remoto (outro Pingger)']])}
    ${field('O que tracear', 'mode', st, 'text', [['full', 'Rota completa'], ['final', 'Só o destino'], ['hop', 'Um hop específico']])}
    ${field('Hop (modo "um hop")', 'hop', st, 'number')}
    ${field('Porta TCP/UDP', 'port', st, 'number')}
    ${field('Tamanho do pacote (bytes)', 'packet_size', st, 'number')}
    ${field('Timeout (ms)', 'timeout_ms', st, 'number')}
    ${field('Máx. de hops', 'max_hops', st, 'number')}
    ${field('TOS / DSCP (byte)', 'tos', st, 'number', null, 'Ex.: 184 = EF (voz). Só ICMP.')}
    ${field('Não fragmentar (DF)', 'dont_fragment', st, 'checkbox', null, 'Útil para descobrir MTU com pacotes grandes.')}
    ${field('Versão do IP', 'ip_version', st, 'text', [['auto', 'Automático'], ['4', 'IPv4'], ['6', 'IPv6']])}
    ${field('Resolver nomes (DNS reverso)', 'resolve_names', st, 'checkbox')}
    ${field('URL do agente remoto', 'agent_url', st, 'text', null, 'Ex.: http://192.168.0.50:7465 — o outro Pingger precisa estar com o agente ativado.')}
    ${field('Chave do agente', 'agent_key', st, 'password')}
    ${field('Salvar dados (auto-save)', 'keep', st, 'checkbox')}
    ${field('Amostras em memória', 'max_samples_memory', st, 'number')}
  </div>`;
  modal('Opções do alvo — ' + s.host, html, [
    ['Cancelar', null],
    ['Salvar', async bg => { await api(`sessions/${sid}`, { body: readFields(bg, st) }); await poll(); refreshSession(); toast('Opções salvas'); }, 'primary'],
  ]);
}

// ============================================================ resumos
async function newSummary() {
  const name = prompt('Nome do resumo:', 'Resumo');
  if (!name) return;
  const sm = await api('summaries', { body: { name, members: S.state.sessions.map(s => s.id) } });
  await poll(); go('summary', sm.id);
}

async function refreshSummary() {
  const sm = S.state.summaries.find(x => x.id === S.view.id);
  if (!sm) return go('home');
  S.busy = true;
  try {
    const { start, end } = windowRange();
    const members = sm.members.map(id => S.state.sessions.find(s => s.id === id)).filter(Boolean);
    const rows = await Promise.all(members.map(async s => {
      const h = await api(`sessions/${s.id}/hops?` + qs({ start, end }));
      const tl = await api(`sessions/${s.id}/timeline?` + qs({ hop: -1, start, end, buckets: 400 }));
      return { s, f: h.hops[h.hops.length - 1] || {}, tl };
    }));
    let main = $('#main');
    if (!main.querySelector('#sumCard') || main._sum !== sm.id + members.map(m => m.id).join()) {
      main._sum = sm.id + members.map(m => m.id).join();
      main.innerHTML = `<div class="card" id="sumCard"><div class="hd"><h2>▦ ${esc(sm.name)}</h2><span class="sub">destino de cada alvo no período</span>
        <div class="spacer"></div><select id="periodSel">${PERIODS.map(([v, l]) => `<option value="${v}" ${v === S.period ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button id="smEdit">Membros…</button><button id="smRen">Renomear</button><button class="danger" id="smDel">Excluir</button></div>
        <div class="bd"><table class="list"><thead><tr><th>Alvo</th><th>IP</th><th class="num" style="text-align:right">Média</th><th style="text-align:right">Mín</th><th style="text-align:right">Máx</th>
        <th style="text-align:right">Perda %</th><th style="text-align:right">Jitter</th><th style="text-align:right">MOS</th><th style="width:40%">Linha do tempo</th></tr></thead>
        <tbody>${members.map(s => `<tr data-sid="${s.id}" style="cursor:pointer"><td><span class="dot ${statusClass(s)}" style="display:inline-block"></span> ${esc(s.name)}</td>
        <td>${esc(s.ip)}</td><td class="num" data-c="avg"></td><td class="num" data-c="min"></td><td class="num" data-c="max"></td><td class="num" data-c="loss_pct"></td>
        <td class="num" data-c="jitter"></td><td class="num" data-c="mos"></td><td><canvas height="40" style="width:100%"></canvas></td></tr>`).join('')}</tbody></table>
        ${members.length ? '' : '<p class="sub">Nenhum alvo neste resumo. Use “Membros…”.</p>'}</div></div>`;
      main.querySelectorAll('tr[data-sid]').forEach(tr => tr.onclick = () => go('session', tr.dataset.sid));
      $('#periodSel').onchange = e => { S.period = Number(e.target.value); refreshSummary(); };
      $('#smDel').onclick = async () => { if (confirm('Excluir resumo?')) { await api('summaries/' + sm.id, { method: 'DELETE' }); await poll(); go('home'); } };
      $('#smRen').onclick = async () => { const n = prompt('Novo nome', sm.name); if (n) { await api('summaries', { body: { id: sm.id, name: n } }); await poll(); main._sum = null; refreshSummary(); } };
      $('#smEdit').onclick = () => {
        modal('Membros de ' + sm.name, S.state.sessions.map(s => `<label class="row"><input type="checkbox" value="${s.id}" ${sm.members.includes(s.id) ? 'checked' : ''}> ${esc(s.name)} <span class="sub">${esc(s.ip)}</span></label>`).join('') || 'Nenhum alvo aberto.', [
          ['Cancelar', null],
          ['Salvar', async bg => { await api('summaries', { body: { id: sm.id, members: [...bg.querySelectorAll('input:checked')].map(i => i.value) } }); await poll(); main._sum = null; refreshSummary(); }, 'primary']]);
      };
    }
    rows.forEach(({ s, f, tl }) => {
      const tr = main.querySelector(`tr[data-sid="${s.id}"]`);
      if (!tr) return;
      tr.querySelectorAll('[data-c]').forEach(td => {
        const k = td.dataset.c, v = f[k];
        td.textContent = k === 'mos' ? fmt(v, 2) : fmt(v);
        td.style.color = k === 'avg' ? latColor(v) : k === 'loss_pct' && v > 0 ? css('--bad') : '';
      });
      const cv = tr.querySelector('canvas');
      drawTimeline(cv, tl);
    });
  } finally { S.busy = false; }
}

// ============================================================ alertas
async function renderAlerts() {
  const alerts = await api('alerts');
  const active = S.state.active_alerts;
  $('#main').innerHTML = `<div class="card"><div class="hd"><h2>🔔 Alertas</h2><div class="spacer"></div><button class="primary" id="aNew">+ Novo alerta</button></div>
    <div class="bd"><p class="sub">Um alerta tem uma <b>condição</b> (o que observar) e <b>ações</b> (o que fazer quando ela acontece). Vincule cada alerta aos alvos desejados.</p>
    <table class="list"><thead><tr><th>Nome</th><th>Condição</th><th>Ações</th><th>Alvos</th><th>Estado</th><th></th></tr></thead><tbody>
    ${alerts.map(a => {
      const act = active.filter(x => x.alert === a.id);
      const tg = a.applies_to === '*' || (a.applies_to || []).includes('*') ? 'todos' : (a.applies_to || []).map(id => S.state.sessions.find(s => s.id === id)?.name || '?').join(', ') + (a.applies_cidr ? ' ' + a.applies_cidr : '');
      return `<tr><td>${a.enabled ? '' : '<span class="badge">off</span> '}${esc(a.name)}</td><td>${esc(S.meta.conditions[a.condition.type])}</td>
      <td>${a.actions.map(x => esc(S.meta.actions[x.type])).join(', ')}</td><td>${esc(tg || '—')}</td>
      <td>${act.length ? `<span class="badge focus">⚠ ativo em ${act.length}</span>` : '<span class="sub">ok</span>'}</td>
      <td style="text-align:right"><button class="small" data-e="${a.id}">Editar</button> <button class="small" data-t="${a.id}">Testar</button> <button class="small danger" data-d="${a.id}">Excluir</button></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="sub">Nenhum alerta configurado.</td></tr>'}</tbody></table></div></div>`;
  $('#aNew').onclick = () => editAlert({});
  $('#main').querySelectorAll('[data-e]').forEach(b => b.onclick = () => editAlert(alerts.find(a => a.id === b.dataset.e)));
  $('#main').querySelectorAll('[data-d]').forEach(b => b.onclick = async () => { if (confirm('Excluir alerta?')) { await api('alerts/' + b.dataset.d, { method: 'DELETE' }); renderAlerts(); } });
  $('#main').querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
    const a = alerts.find(x => x.id === b.dataset.t);
    const sid = (a.applies_to || []).find(id => S.state.sessions.some(s => s.id === id)) || S.state.sessions[0]?.id;
    if (!sid) return toast('Abra um alvo para testar', true);
    await api(`sessions/${sid}/test-alert`, { body: { alert: a.id } }); toast('Ações do alerta disparadas (teste)');
  });
}

const COND_FIELDS = {
  latency_loss: [['over_ms', 'Latência acima de (ms)'], ['samples_over', 'Amostras ruins necessárias'], ['samples_examine', 'Em quantas amostras recentes']],
  loss_pct: [['percent', 'Perda acima de (%)'], ['seconds', 'Janela (segundos)'], ['min_samples', 'Mínimo de amostras']],
  latency_avg: [['over_ms', 'Média acima de (ms)'], ['seconds', 'Janela (segundos)'], ['min_samples', 'Mínimo de amostras']],
  jitter: [['over_ms', 'Jitter acima de (ms)'], ['seconds', 'Janela (segundos)'], ['min_samples', 'Mínimo de amostras']],
  mos: [['mos', 'MOS abaixo de'], ['seconds', 'Janela (segundos)'], ['min_samples', 'Mínimo de amostras']],
  unreachable: [['samples_over', 'Amostras seguidas sem resposta']],
  route_change: [],
};
const ACT_FIELDS = {
  sound: [['file', 'Som', 'sound']],
  notify: [['title', 'Título'], ['body', 'Texto']],
  email: [['to', 'Para (vazio = padrão das configurações)'], ['subject', 'Assunto'], ['body', 'Corpo', 'textarea']],
  log: [['path', 'Arquivo (vazio = alertas.log na pasta de dados)'], ['format', 'Formato da linha']],
  exec: [['program', 'Programa (caminho do .exe/.bat)'], ['args', 'Argumentos']],
  webhook: [['url', 'URL'], ['method', 'Método', ['POST', 'GET', 'PUT']], ['content_type', 'Content-Type'], ['body', 'Corpo (vazio = JSON com todas as variáveis)', 'textarea']],
  save: [['folder', 'Pasta (vazio = pasta de dados/alert-saves)']],
  summary_add: [['summary', 'Nome do resumo']],
  summary_remove: [['summary', 'Nome do resumo']],
  mode_full: [], mode_final: [],
};

function editAlert(a0) {
  const a = JSON.parse(JSON.stringify({
    name: 'Novo alerta', enabled: true, applies_to: [], applies_cidr: '', notify_when: 'start', repeat_seconds: 0, actions: [{ type: 'notify' }], ...a0,
    condition: { type: 'latency_loss', over_ms: 200, samples_over: 5, samples_examine: 10, seconds: 300, percent: 10, mos: 3.5, min_samples: 10, hop: 'final', ...(a0.condition || {}) },
  }));
  const bg = modal(a.id ? 'Editar alerta' : 'Novo alerta', '', [
    ['Cancelar', null],
    ['Salvar', async () => { collect(); await api('alerts', { body: a }); if (S.view.kind === 'alerts') renderAlerts(); toast('Alerta salvo'); }, 'primary'],
  ]);
  const body = bg.querySelector('.mbody');
  const draw = () => {
    const c = a.condition;
    body.innerHTML = `<fieldset><legend>Geral</legend><div class="form">
      <label>Nome</label><input id="aName" value="${esc(a.name)}"><label>Ativo</label><div><input type="checkbox" id="aEn" ${a.enabled ? 'checked' : ''}></div></div></fieldset>
      <fieldset><legend>Condição</legend><div class="form">
      <label>Tipo</label><select id="cType">${Object.entries(S.meta.conditions).map(([k, v]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <label>Hop observado</label><input id="cHop" value="${esc(c.hop)}" title='"final" ou número do hop'>
      ${COND_FIELDS[c.type].map(([k, l]) => `<label>${esc(l)}</label><input data-c="${k}" type="number" step="any" value="${esc(c[k])}">`).join('')}
      <label>Notificar quando</label><select id="aWhen">${[['start', 'A condição começa'], ['end', 'A condição termina'], ['both', 'Começa e termina'], ['always', 'Enquanto durar (a cada amostra)']].map(([k, v]) => `<option value="${k}" ${k === a.notify_when ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label>Repetir a cada (s, 0 = não)</label><input id="aRep" type="number" value="${esc(a.repeat_seconds)}"></div></fieldset>
      <fieldset><legend>Ações</legend><div id="acts"></div>
      <div class="row"><select id="actNew">${Object.entries(S.meta.actions).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select><button id="actAdd">+ Adicionar ação</button></div>
      <p class="sub">Variáveis: $host $name $ip $alertname $state $reason $time $latency $loss $jitter $mos $samples $route</p></fieldset>
      <fieldset><legend>Aplicar a</legend>
      <label class="row"><input type="checkbox" id="aAll" ${a.applies_to === '*' || (a.applies_to || []).includes('*') ? 'checked' : ''}> Todos os alvos (atuais e futuros)</label>
      ${S.state.sessions.map(s => `<label class="row"><input type="checkbox" class="aT" value="${s.id}" ${(a.applies_to || []).includes(s.id) ? 'checked' : ''}> ${esc(s.name)} <span class="sub">${esc(s.ip)}</span></label>`).join('')}
      <div class="form" style="margin-top:6px"><label>Ou faixa de IP (CIDR / ALL)</label><input id="aCidr" value="${esc(a.applies_cidr)}" placeholder="ex.: 10.0.0.0/8"></div></fieldset>`;
    const acts = body.querySelector('#acts');
    acts.innerHTML = a.actions.map((x, i) => `<div class="action-box" data-i="${i}"><div class="row"><b>${esc(S.meta.actions[x.type])}</b><div class="spacer"></div><button class="small danger" data-rm="${i}">Remover</button></div>
      <div class="form">${ACT_FIELDS[x.type].map(([k, l, t]) => {
        const v = x[k] ?? '';
        if (t === 'sound') return `<label>${l}</label><div class="row"><select data-a="${k}">${S.meta.sounds.map(s => `<option ${s === v ? 'selected' : ''}>${s}</option>`).join('')}</select><span class="sub">ou caminho .wav:</span><input data-a="${k}_custom" value="${S.meta.sounds.includes(v) ? '' : esc(v)}"></div>`;
        if (Array.isArray(t)) return `<label>${l}</label><select data-a="${k}">${t.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
        if (t === 'textarea') return `<label>${l}</label><textarea data-a="${k}" rows="3">${esc(v)}</textarea>`;
        return `<label>${l}</label><input data-a="${k}" value="${esc(v)}">`;
      }).join('')}</div></div>`).join('') || '<p class="sub">Nenhuma ação.</p>';
    body.querySelector('#cType').onchange = e => { collect(); a.condition.type = e.target.value; draw(); };
    body.querySelector('#actAdd').onclick = () => { collect(); a.actions.push({ type: body.querySelector('#actNew').value }); draw(); };
    acts.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { collect(); a.actions.splice(Number(b.dataset.rm), 1); draw(); });
  };
  function collect() {
    if (!body.querySelector('#aName')) return;
    a.name = body.querySelector('#aName').value;
    a.enabled = body.querySelector('#aEn').checked;
    a.condition.hop = body.querySelector('#cHop').value || 'final';
    body.querySelectorAll('[data-c]').forEach(i => a.condition[i.dataset.c] = Number(i.value));
    a.notify_when = body.querySelector('#aWhen').value;
    a.repeat_seconds = Number(body.querySelector('#aRep').value) || 0;
    a.applies_to = body.querySelector('#aAll').checked ? ['*'] : [...body.querySelectorAll('.aT:checked')].map(i => i.value);
    a.applies_cidr = body.querySelector('#aCidr').value.trim();
    body.querySelectorAll('.action-box').forEach(box => {
      const x = a.actions[Number(box.dataset.i)];
      box.querySelectorAll('[data-a]').forEach(i => { if (!i.dataset.a.endsWith('_custom')) x[i.dataset.a] = i.value; });
      const custom = box.querySelector('[data-a="file_custom"]');
      if (custom && custom.value.trim()) x.file = custom.value.trim();
    });
  }
  draw();
}

// ============================================================ eventos e sessões salvas
async function renderEvents() {
  const ev = await api('events?limit=1000');
  const names = Object.fromEntries(S.state.sessions.map(s => [s.id, s.name]));
  const label = { alert_start: '⚠ Início', alert_end: '✓ Fim', alert_fire: '🔔 Disparo', route_change: '↔ Rota', action_error: '✕ Erro' };
  $('#main').innerHTML = `<div class="card"><div class="hd"><h2>📜 Log de eventos</h2><div class="spacer"></div><button id="evRef">Atualizar</button><button class="danger" id="evClr">Limpar</button></div>
    <div class="bd"><table class="list"><thead><tr><th>Quando</th><th>Tipo</th><th>Alvo</th><th>Alerta</th><th>Mensagem</th></tr></thead><tbody>
    ${ev.map(e => `<tr><td>${fmtDate(e.ts)}</td><td>${label[e.kind] || esc(e.kind)}</td><td>${esc(names[e.session] || e.session || '')}</td><td>${esc(e.alert || '')}</td><td>${esc(e.message)}</td></tr>`).join('') || '<tr><td colspan="5" class="sub">Sem eventos.</td></tr>'}
    </tbody></table></div></div>`;
  $('#evRef').onclick = renderEvents;
  $('#evClr').onclick = async () => { await api('events', { method: 'DELETE' }); renderEvents(); };
}

async function renderSaved() {
  const rows = await api('sessions/saved');
  const open = new Set(S.state.sessions.map(s => s.id));
  $('#main').innerHTML = `<div class="card"><div class="hd"><h2>🕘 Sessões salvas</h2><span class="sub">dados guardados no banco local — abra para analisar o histórico ou retomar o trace</span></div>
    <div class="bd"><table class="list"><thead><tr><th>Alvo</th><th>Criada</th><th>Última amostra</th><th style="text-align:right">Amostras</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.name)} <span class="sub">${r.name !== r.host ? esc(r.host) : ''}</span></td><td>${fmtDate(r.created)}</td><td>${fmtDate(r.last)}</td><td class="num">${r.samples}</td>
      <td style="text-align:right">${open.has(r.id) ? `<button class="small" data-go="${r.id}">Ver</button>` : `<button class="small" data-h="${r.id}">Abrir histórico</button> <button class="small" data-r="${r.id}">Retomar trace</button>`}
      <button class="small danger" data-x="${r.id}">Apagar</button></td></tr>`).join('') || '<tr><td colspan="5" class="sub">Nada salvo ainda.</td></tr>'}</tbody></table></div></div>`;
  const m = $('#main');
  m.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go('session', b.dataset.go));
  m.querySelectorAll('[data-h],[data-r]').forEach(b => b.onclick = async () => {
    const id = b.dataset.h || b.dataset.r;
    await api(`sessions/${id}/open`, { body: { start: !!b.dataset.r } }); await poll();
    go('session', id);
    if (b.dataset.h) { const s = curSession(); if (s && s.last) { S.offset = Math.max(0, S.state.server_time - s.last); S.period = PERIODS.find(p => p[0] >= (s.last - s.first))?.[0] || 604800; refreshSession(); } }
  });
  m.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => {
    if (!confirm('Apagar a sessão e todos os dados?')) return;
    await api(`sessions/${b.dataset.x}?purge=1`, { method: 'DELETE' }); renderSaved();
  });
}

// ============================================================ workspaces
async function switchWorkspace(v) {
  if (v === '__new') {
    const n = prompt('Nome do novo workspace:'); if (n) { await api('workspaces', { body: { action: 'new', name: n } }); await poll(); go('home'); }
  } else if (v === '__save') {
    const n = prompt('Salvar workspace como:'); if (n) await api('workspaces', { body: { name: n } });
  } else if (v === '__manage') {
    const ws = await api('workspaces');
    modal('Workspaces', `<table class="list">${Object.entries(ws.all).map(([n, w]) => `<tr><td>${esc(n)}${n === ws.current ? ' <span class="badge live">atual</span>' : ''}</td><td class="sub">${w.sessions.length} alvo(s) · salvo ${fmtDate(w.saved)}</td>
      <td><button class="small danger" data-del="${esc(n)}">Excluir</button></td></tr>`).join('')}</table>`).querySelectorAll('[data-del]').forEach(b =>
      b.onclick = async () => { await api('workspaces', { body: { action: 'delete', name: b.dataset.del } }); b.closest('tr').remove(); refreshWorkspaces(); });
  } else {
    await api('workspaces', { body: { action: 'load', name: v } }); await poll();
    S.state.sessions.length ? go('session', S.state.sessions[0].id) : go('home');
  }
  refreshWorkspaces();
}

// ============================================================ configurações
function renderSettings() {
  const st = S.settings, ae = st.auto_export, df = st.defaults;
  $('#main').innerHTML = `<div class="card"><div class="hd"><h2>⚙ Configurações</h2><div class="spacer"></div><button class="primary" id="setSave">Salvar</button></div><div class="bd">
  <fieldset id="fsGen"><legend>Exibição</legend><div class="form">
    ${field('Tema', 'theme', st, 'text', [['auto', 'Sistema'], ['light', 'Claro'], ['dark', 'Escuro']])}
    ${field('Latência amarela a partir de (ms)', 'latency_warn', st, 'number')}
    ${field('Latência vermelha a partir de (ms)', 'latency_bad', st, 'number')}
    ${field('Escala dos gráficos', 'graph_scale', st, 'text', ['auto', 50, 100, 200, 300, 500, 1000, 2000])}
    ${field('Escala da perda na timeline (%)', 'loss_scale', st, 'number', null, 'Perda neste valor ou acima ocupa toda a altura do gráfico.')}
    ${field('Linha-alvo do jitter (ms)', 'jitter_target', st, 'number')}
    ${field('Mostrar gráfico de jitter', 'show_jitter_graph', st, 'checkbox')}
    ${field('Marcar mudanças de rota', 'show_route_changes', st, 'checkbox')}
    ${field('Período padrão da timeline', 'default_period', st, 'number', PERIODS)}
    ${field('Amostras para estatísticas', 'samples_to_include', st, 'number', null, '0 = todas as amostras do período visível; N = últimas N amostras (ao vivo).')}
  </div></fieldset>
  <fieldset id="fsDef"><legend>Padrões para novos alvos</legend><div class="form">
    ${field('Intervalo (s)', 'interval', df, 'number', INTERVALS.map(i => [i, fmtInt(i)]))}
    ${field('Tipo de pacote', 'engine', df, 'text', [['icmp', 'ICMP'], ['tcp', 'TCP'], ['udp', 'UDP']])}
    ${field('Porta TCP/UDP', 'port', df, 'number')}
    ${field('Tamanho do pacote', 'packet_size', df, 'number')}
    ${field('Timeout (ms)', 'timeout_ms', df, 'number')}
    ${field('Máx. de hops', 'max_hops', df, 'number')}
    ${field('Resolver nomes', 'resolve_names', df, 'checkbox')}
    ${field('Salvar dados automaticamente', 'keep', df, 'checkbox')}
  </div></fieldset>
  <fieldset id="fsNamed"><legend>Configurações nomeadas</legend><div class="form">
    ${field('Presets (JSON)', 'named_configs', st, 'textarea', null, 'Cada preset sobrescreve as opções do alvo. Aparecem no seletor ao lado do campo de alvo.')}
  </div></fieldset>
  <fieldset id="fsData"><legend>Dados</legend><div class="form">
    ${field('Manter histórico por (dias)', 'retention_days', st, 'number')}
    ${field('Gravar no banco a cada (s)', 'flush_seconds', st, 'number')}
    <label>Pasta de dados</label><div class="sub">${esc(S.meta.data_dir)}</div>
  </div></fieldset>
  <fieldset id="fsAE"><legend>Exportação automática</legend><div class="form">
    ${field('Ativar', 'enabled', ae, 'checkbox')}
    ${field('A cada (minutos)', 'minutes', ae, 'number')}
    ${field('Formato', 'format', ae, 'text', [['csv', 'CSV'], ['pgr', 'Sessão .pgr']])}
    ${field('Pasta', 'folder', ae, 'text', null, 'Vazio = pasta de dados/auto-export')}
  </div></fieldset>
  <fieldset id="fsMail"><legend>E-mail (SMTP) para alertas</legend><div class="form">
    ${field('Servidor', 'smtp_host', st)}${field('Porta', 'smtp_port', st, 'number')}
    ${field('Segurança', 'smtp_security', st, 'text', [['starttls', 'STARTTLS (587)'], ['ssl', 'SSL/TLS (465)'], ['none', 'Nenhuma']])}
    ${field('Usuário', 'smtp_user', st)}${field('Senha', 'smtp_password', st, 'password', null, 'Gmail/Outlook exigem senha de app.')}
    ${field('Remetente', 'smtp_from', st)}${field('Destinatário padrão', 'smtp_to', st)}
  </div></fieldset>
  <fieldset id="fsWeb"><legend>Servidor web / acesso remoto</legend><div class="form">
    ${field('Porta', 'port', st, 'number', null, 'Requer reiniciar o Pingger.')}
    ${field('Escutar em', 'bind', st, 'text', [['127.0.0.1', 'Só este computador'], ['0.0.0.0', 'Toda a rede (exige senha)']])}
    ${field('Senha do painel remoto', 'web_password', st, 'password')}
  </div></fieldset>
  <fieldset id="fsAgent"><legend>Agente remoto</legend><div class="form">
    ${field('Permitir que outros Pinggers traceiem a partir desta máquina', 'agent_enabled', st, 'checkbox', null, 'Requer “Escutar em: toda a rede”.')}
    ${field('Chave do agente', 'agent_key', st, 'password')}
  </div></fieldset>
  <fieldset id="fsSec"><legend>Segurança</legend><div class="form">
    ${field('Permitir ação “Executar um programa” nos alertas', 'allow_exec', st, 'checkbox')}
  </div></fieldset>
  </div></div>`;
  $('#setSave').onclick = async () => {
    try {
      const patch = {};
      for (const id of ['fsGen', 'fsNamed', 'fsData', 'fsMail', 'fsWeb', 'fsAgent', 'fsSec']) Object.assign(patch, readFields($('#' + id), st));
      patch.defaults = { ...df, ...readFields($('#fsDef'), df) };
      patch.auto_export = { ...ae, ...readFields($('#fsAE'), ae) };
      Object.keys(patch).forEach(k => { if (!(k in st)) delete patch[k]; });
      const restart = patch.port !== st.port || patch.bind !== st.bind;
      S.settings = await api('settings', { body: patch });
      applyTheme(); fillConfigs();
      toast(restart ? 'Salvo. Reinicie o Pingger para aplicar porta/endereço.' : 'Configurações salvas');
    } catch (e) { toast('Erro: ' + e.message, true); }
  };
}

window.addEventListener('error', e => toast('Erro: ' + e.message, true, 10000));
window.addEventListener('unhandledrejection', e => { if (e.reason?.message !== 'login') toast('Erro: ' + (e.reason?.message || e.reason), true, 10000); });
init();
