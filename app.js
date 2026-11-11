'use strict';
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const POSTOS = { bombeiro: { n: 'Bombeiro', r: 1 }, chefe: { n: 'Chefe', r: 2 }, comando: { n: 'Comando', r: 3 }, central: { n: 'Central', r: 4 } };
const PRIO_MSG = ['Normal', 'Prioritária', 'Urgente', 'Emergência'];
const PRIO_OCC = { 1: 'Crítica', 2: 'Alta', 3: 'Normal' };
const PRIO_COR = { 1: '#c8102e', 2: '#e0a100', 3: '#1f5fbf' };
const EST_OCC = ['Aberta', 'Em curso', 'Concluída'];
const EST_VEI = ['Disponível', 'Em ocorrência', 'Inoperacional'];
const EST_EL = ['Disponível', 'Em serviço', 'Indisponível'];

const S = { me: null, cfg: null, M: {}, membros: [], veiculos: [], V: {}, ocorr: [], O: {}, msgs: [], regs: [],
  sel: null, tab: 'mapa', filter: 'ativas', chatFilter: 0, msgPrio: 0, picking: false, editing: null,
  chatSeen: Date.now(), dirty: false, started: false, forceBottom: false,
  selectedMemberForAssign: null, dismissedOpBanner: false, dndInitialized: false };
let es = null, loadT = null;

/* ---------------- utilidades ---------------- */
const rank = () => POSTOS[S.me?.posto]?.r || 0;
function can(a) {
  const r = rank();
  return { criarOcorr: r >= 2, editarOcorr: r >= 2, gerirTrip: r >= 2, apagarOcorr: r >= 3, gerirVei: r >= 3, gerirContas: r >= 3, config: r >= 4 }[a] || false;
}
const nm = (u) => S.M[u]?.nome || 'Elemento';
const postoTag = (u) => { const p = S.M[u]?.posto; return p ? `<span class="posto ${p}">${POSTOS[p].n}</span>` : ''; };
const dotCls = (e) => e === 'Em serviço' ? 'servico' : e === 'Indisponível' ? 'indisp' : '';
const stCls = (e) => e === 'Aberta' ? 'st-aberta' : e === 'Em curso' ? 'st-curso' : 'st-concluida';
const opts = (arr, sel) => arr.map((v) => `<option${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
function hora(ts) {
  if (!ts) return '';
  const d = new Date(ts), n = new Date();
  const h = d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === n.toDateString() ? h : d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' }) + ' ' + h;
}
let toastT;
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), isErr ? 6000 : 3500);
}
function arm(b) {
  if (b.dataset.armed) return true;
  b.dataset.armed = '1'; const t = b.textContent; b.textContent = 'Confirmar'; b.classList.add('armed');
  setTimeout(() => { if (b.isConnected && b.dataset.armed) { delete b.dataset.armed; b.textContent = t; b.classList.remove('armed'); } }, 4000);
  return false;
}
function genPw() {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(12));
  return [...r].map((x) => a[x % a.length]).join('');
}
let ac = null;
document.addEventListener('pointerdown', () => { try { ac = ac || new AudioContext(); ac.resume(); } catch (e) {} }, { once: true });
function beep(n = 1, f = 880) {
  try {
    ac = ac || new AudioContext();
    for (let i = 0; i < n; i++) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'square'; o.frequency.value = f; g.gain.value = 0.07; o.connect(g); g.connect(ac.destination);
      const t = ac.currentTime + i * 0.32; o.start(t); o.stop(t + 0.2);
    }
  } catch (e) {}
  try { navigator.vibrate?.(n > 2 ? [300, 120, 300, 120, 300] : [200]); } catch (e) {}
}

/* ---------------- API ---------------- */
async function api(method, url, body, raw) {
  const o = { method, headers: { 'X-Sala': '1' }, credentials: 'same-origin' };
  if (raw) { o.body = raw.body; o.headers['Content-Type'] = raw.type; Object.assign(o.headers, raw.headers || {}); }
  else if (body !== undefined) { o.body = JSON.stringify(body); o.headers['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetch(url, o); } catch (e) { throw new Error('Sem ligação ao servidor. Verifica a rede.'); }
  let d = {}; try { d = await r.json(); } catch (e) {}
  if (r.status === 401 && url !== '/api/login') { stop(); showLogin(); throw new Error(d.erro || 'Sessão terminada.'); }
  if (r.status === 428) { stop(); showTroca(); throw new Error(d.erro); }
  if (!r.ok) throw new Error(d.erro || 'Erro ' + r.status);
  return d;
}
async function W(p) { try { await p; return true; } catch (e) { toast(e.message, 1); return false; } }

/* ---------------- entrada ---------------- */
function gate(html) {
  $('#gate').hidden = false; $('#gate-body').innerHTML = html;
  $('#top').hidden = $('#main').hidden = $('#bnav').hidden = true;
}
function showLogin(msg) {
  gate(`<form class="form" id="login-f" style="padding:0">
    ${msg ? `<p class="hint" style="margin:0">${esc(msg)}</p>` : ''}
    <label>Utilizador<input id="l-user" class="inp" autocomplete="username" autocapitalize="none" required></label>
    <label>Palavra-passe<input id="l-pw" type="password" class="inp" autocomplete="current-password" required></label>
    <button class="btn red" type="submit" style="padding:10px">Entrar</button></form>`);
  $('#login-f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const d = await api('POST', '/api/login', { utilizador: $('#l-user').value.trim(), password: $('#l-pw').value });
      S.me = d.me; d.me.obrigaTroca ? showTroca() : start();
    } catch (er) { toast(er.message, 1); }
  });
  setTimeout(() => $('#l-user')?.focus(), 50);
}
function showTroca() {
  gate(`<form class="form" id="troca-f" style="padding:0">
    <p style="margin:0">Primeiro acesso ou palavra-passe reposta. Define uma palavra-passe só tua, com pelo menos 10 caracteres.</p>
    <label>Palavra-passe atual (temporária)<input id="t-old" type="password" class="inp" autocomplete="current-password" required></label>
    <label>Nova palavra-passe<input id="t-new" type="password" class="inp" autocomplete="new-password" minlength="10" required></label>
    <label>Repetir nova palavra-passe<input id="t-new2" type="password" class="inp" autocomplete="new-password" required></label>
    <button class="btn red" type="submit" style="padding:10px">Guardar e entrar</button></form>`);
  $('#troca-f').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('#t-new').value !== $('#t-new2').value) { toast('As palavras-passe novas não coincidem.', 1); return; }
    try { const d = await api('POST', '/api/password', { atual: $('#t-old').value, nova: $('#t-new').value }); S.me = d.me; start(); }
    catch (er) { toast(er.message, 1); }
  });
}
async function boot() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (r.status === 401) return showLogin();
    const d = await r.json();
    S.me = d.me; d.me.obrigaTroca ? showTroca() : start();
  } catch (e) { gate('<p>Não foi possível contactar o servidor. Verifica a rede e recarrega a página.</p>'); }
}
async function start() {
  try {
    S.cfg = await api('GET', '/api/config');
    await load();
  } catch (e) { return; }
  $('#gate').hidden = true; $('#top').hidden = $('#main').hidden = $('#bnav').hidden = false;
  applyCfg();
  if (!S.started) {
    S.started = true;
    await Mapa.init($('#map'), S.cfg, onMapClick);
    setupDragAndDrop();
  }
  openEvents();
  render();
}
function stop() { if (es) { es.close(); es = null; } }
async function logout() { stop(); try { await api('POST', '/api/logout'); } catch (e) {} location.reload(); }

/* ---------------- dados e tempo real ---------------- */
async function load() {
  const d = await api('GET', '/api/estado');
  S.membros = d.membros; S.M = Object.fromEntries(d.membros.map((m) => [m.id, m]));
  S.veiculos = d.veiculos; S.V = Object.fromEntries(d.veiculos.map((v) => [v.id, v]));
  S.ocorr = d.ocorrencias; S.O = Object.fromEntries(d.ocorrencias.map((o) => [o.id, o]));
  S.msgs = d.mensagens;
  const me = S.M[S.me.id]; if (me) S.me = { ...S.me, ...me };
  if (S.me && !me?.ativo) { stop(); showLogin('A tua conta foi desativada.'); }
}
function scheduleLoad() { clearTimeout(loadT); loadT = setTimeout(async () => { try { await load(); render(); } catch (e) {} }, 250); }
function setNet(on) { const n = $('#net'); n.classList.toggle('off', !on); n.title = on ? 'Ligado ao servidor' : 'Sem ligação ao servidor'; }
function openEvents() {
  stop();
  es = new EventSource('/api/eventos');
  es.onopen = () => { setNet(true); scheduleLoad(); if (S.sel) loadRegs(); };
  es.onerror = () => {
    setNet(false);
    if (es && es.readyState === EventSource.CLOSED) {
      setTimeout(async () => { try { await api('GET', '/api/me'); openEvents(); } catch (e) { setTimeout(openEvents, 5000); } }, 4000);
    }
  };
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch (er) { return; }
    if (ev.col === 'mensagens' && ev.msg && ev.msg.por !== S.me.id) alertMsg(ev.msg);
    if (ev.col === 'ocorrencias' && ev.nova && ev.nova.prioridade === 1 && ev.nova.por !== S.me.id) {
      toast('Nova ocorrência crítica: ' + ev.nova.tipo + (ev.nova.morada ? ', ' + ev.nova.morada : '')); beep(2, 660);
    }
    if (ev.col === 'registos') { if (S.sel && (ev.id == null || ev.id === S.sel)) loadRegs(); return; }
    if (ev.col === 'config') { api('GET', '/api/config').then((c) => { S.cfg = c; applyCfg(); render(); }).catch(() => {}); return; }
    scheduleLoad();
  };
}

/* ---------------- mapa (Google Maps ou OpenStreetMap) ---------------- */
function loadScript(src) {
  return new Promise((ok, ko) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = ok; s.onerror = ko; document.head.appendChild(s); });
}
function loadCss(href) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }
const Mapa = {
  kind: null, map: null, markers: {}, pick: null, onSel: null,
  async init(el, cfg, onClick) {
    const c = cfg.mapaCentro || { lat: 39.6, lng: -8, zoom: 7 };
    if (cfg.mapsKey) {
      try {
        window.gm_authFailure = () => toast('A chave do Google Maps foi recusada. Verifica a chave e as restrições na Google Cloud.', 1);
        await new Promise((ok, ko) => {
          window.__gmReady = ok;
          loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.mapsKey)}&language=pt-PT&region=PT&loading=async&callback=__gmReady`).catch(ko);
        });
        this.kind = 'google';
        this.map = new google.maps.Map(el, { center: { lat: c.lat, lng: c.lng }, zoom: c.zoom, gestureHandling: 'greedy', streetViewControl: false, fullscreenControl: false,
          mapTypeControl: true, mapTypeControlOptions: { mapTypeIds: ['roadmap', 'hybrid'] }, clickableIcons: false });
        this.map.addListener('click', (e) => onClick({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
        return;
      } catch (e) { toast('Não foi possível carregar o Google Maps. A usar OpenStreetMap.', 1); }
    }
    try {
      loadCss('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css');
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js');
      this.kind = 'leaflet';
      this.map = L.map(el, { zoomControl: true }).setView([c.lat, c.lng], c.zoom);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
        attribution: '© OpenStreetMap contributors, © CARTO'
      }).addTo(this.map);
      this.map.on('click', (e) => onClick({ lat: e.latlng.lat, lng: e.latlng.lng }));
      window.addEventListener('resize', () => this.map.invalidateSize());
    } catch (e) { el.innerHTML = '<p class="empty">Não foi possível carregar o mapa. A lista de ocorrências continua disponível.</p>'; }
  },
  set(list, onSel) {
    if (!this.map) return;
    const seen = new Set();
    for (const o of list) {
      seen.add(o.id);
      const cor = o.done ? '#7b8692' : PRIO_COR[o.prio], r = o.sel ? 11 : 8;
      let m = this.markers[o.id];
      if (this.kind === 'google') {
        const icon = { path: google.maps.SymbolPath.CIRCLE, scale: r, fillColor: cor, fillOpacity: o.done ? 0.6 : 1, strokeColor: '#ffffff', strokeWeight: 3 };
        if (!m) { m = new google.maps.Marker({ map: this.map, position: { lat: o.lat, lng: o.lng }, title: o.title }); m.addListener('click', () => onSel(o.id)); this.markers[o.id] = m; }
        m.setPosition({ lat: o.lat, lng: o.lng }); m.setIcon(icon); m.setTitle(o.title); m.setZIndex(o.sel ? 999 : o.done ? 1 : 10 - o.prio);
      } else {
        const st = { radius: r, color: '#ffffff', weight: 3, fillColor: cor, fillOpacity: o.done ? 0.6 : 1 };
        if (!m) { m = L.circleMarker([o.lat, o.lng], st).addTo(this.map).on('click', (e) => { L.DomEvent.stopPropagation(e); onSel(o.id); }); m.bindTooltip(o.title); this.markers[o.id] = m; }
        m.setLatLng([o.lat, o.lng]); m.setStyle(st); m.setTooltipContent(o.title); if (o.sel) m.bringToFront();
      }
    }
    for (const id in this.markers) if (!seen.has(+id)) { this.kind === 'google' ? this.markers[id].setMap(null) : this.map.removeLayer(this.markers[id]); delete this.markers[id]; }
  },
  setPick(p) {
    if (!this.map) return;
    if (this.pick) { this.kind === 'google' ? this.pick.setMap(null) : this.map.removeLayer(this.pick); this.pick = null; }
    if (!p) return;
    this.pick = this.kind === 'google'
      ? new google.maps.Marker({ map: this.map, position: p, clickable: false, zIndex: 1000, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 13, fillColor: '#c8102e', fillOpacity: 0.25, strokeColor: '#c8102e', strokeWeight: 3 } })
      : L.circleMarker([p.lat, p.lng], { radius: 13, color: '#c8102e', weight: 3, dashArray: '4 4', fillOpacity: 0.2, interactive: false }).addTo(this.map);
  },
  pan(lat, lng, zoom) {
    if (!this.map) return;
    if (this.kind === 'google') { this.map.panTo({ lat, lng }); if (zoom) this.map.setZoom(zoom); }
    else zoom ? this.map.setView([lat, lng], zoom) : this.map.panTo([lat, lng]);
  },
  view() {
    if (!this.map) return null;
    if (this.kind === 'google') { const c = this.map.getCenter(); return { lat: c.lat(), lng: c.lng(), zoom: this.map.getZoom() }; }
    const c = this.map.getCenter(); return { lat: c.lat, lng: c.lng, zoom: this.map.getZoom() };
  },
  resize() { if (this.kind === 'leaflet') setTimeout(() => this.map.invalidateSize(), 30); },
};
function renderMap() {
  const list = S.ocorr.filter((o) => { const d = o.estado === 'Concluída'; return S.filter === 'todas' || (S.filter === 'ativas' ? !d : d); })
    .map((o) => ({ id: o.id, lat: o.lat, lng: o.lng, prio: o.prioridade, done: o.estado === 'Concluída', sel: o.id === S.sel,
      title: o.tipo + (o.morada ? ', ' + o.morada : '') }));
  Mapa.set(list, (id) => { if (!S.picking) select(id); });
}
function onMapClick(ll) { if (S.picking) placePick(ll); }
function startPick() { if (S.tab !== 'mapa') setTab('mapa'); closeDet(); S.editing = null; S.picking = true; $('#pickbar').hidden = false; $('#btn-new').hidden = true; }
function stopPick() { S.picking = false; $('#pickbar').hidden = true; $('#btn-new').hidden = !can('criarOcorr'); Mapa.setPick(null); }
function placePick(ll) {
  Mapa.setPick(ll); S.picking = false; $('#pickbar').hidden = true;
  $('#f-lat').value = (+ll.lat).toFixed(6); $('#f-lng').value = (+ll.lng).toFixed(6);
  openDlg();
}
function openDlg() {
  const o = S.editing && S.O[S.editing];
  $('#dlg-title').textContent = o ? 'Editar ocorrência' : 'Nova ocorrência';
  $('#occ-save').textContent = o ? 'Guardar alterações' : 'Registar ocorrência';
  if (o && !$('#dlg-occ').dataset.filled) {
    $('#f-tipo').innerHTML = opts([...new Set([...S.cfg.tiposOcorrencia, o.tipo])], o.tipo);
    $('#f-prio').value = o.prioridade; $('#f-sado').value = o.sado || ''; $('#f-morada').value = o.morada || '';
    $('#f-desc').value = o.descricao || '';
    if (!$('#f-lat').value) { $('#f-lat').value = o.lat; $('#f-lng').value = o.lng; }
    $('#dlg-occ').dataset.filled = '1';
  }
  if (!$('#dlg-occ').open) $('#dlg-occ').showModal();
}
function resetDlg() {
  ['#f-sado', '#f-morada', '#f-desc', '#f-lat', '#f-lng'].forEach((s) => ($(s).value = ''));
  $('#f-prio').value = '2'; $('#f-tipo').innerHTML = opts(S.cfg.tiposOcorrencia); delete $('#dlg-occ').dataset.filled; S.editing = null;
}
function geo(ok) {
  if (!navigator.geolocation) { toast('Este dispositivo não indica a localização. Toca no mapa.', 1); return; }
  toast('A obter localização…');
  navigator.geolocation.getCurrentPosition((p) => { const ll = { lat: p.coords.latitude, lng: p.coords.longitude }; Mapa.pan(ll.lat, ll.lng, 16); ok(ll); },
    () => toast('Localização indisponível. Confirma que a app abre em HTTPS e que deste permissão. Toca no mapa para marcar.', 1),
    { enableHighAccuracy: true, timeout: 12000 });
}
async function saveOcc() {
  const lat = parseFloat($('#f-lat').value.replace(',', '.')), lng = parseFloat($('#f-lng').value.replace(',', '.'));
  if (!isFinite(lat) || !isFinite(lng)) { toast('Marca o local no mapa ou indica latitude e longitude.', 1); return; }
  const body = { tipo: $('#f-tipo').value, prioridade: +$('#f-prio').value, sado: $('#f-sado').value, morada: $('#f-morada').value, descricao: $('#f-desc').value, lat, lng };
  const b = $('#occ-save'); b.disabled = true;
  try {
    if (S.editing) { const id = S.editing; await api('PATCH', '/api/ocorrencias/' + id, body); toast('Ocorrência atualizada'); $('#dlg-occ').close(); resetDlg(); stopPick(); await load(); select(id); }
    else { const d = await api('POST', '/api/ocorrencias', body); toast('Ocorrência registada'); $('#dlg-occ').close(); resetDlg(); stopPick(); await load(); select(d.id); }
  } catch (e) { toast(e.message, 1); } finally { b.disabled = false; }
}

/* ---------------- lista e detalhe ---------------- */
function renderStats() {
  const ativas = S.ocorr.filter((o) => o.estado !== 'Concluída');
  $('#stats').innerHTML = `<div><b>${ativas.length}</b><span>Ativas</span></div><div class="crit"><b>${ativas.filter((o) => o.prioridade === 1).length}</b><span>Críticas</span></div><div><b>${S.veiculos.filter((v) => v.estado === 'Disponível').length}<small style="font-size:16px;color:var(--muted)">/${S.veiculos.length}</small></b><span>Meios disponíveis</span></div>`;
}
function renderList() {
  renderStats();
  const f = S.filter;
  const arr = S.ocorr.filter((o) => f === 'todas' || (f === 'ativas' ? o.estado !== 'Concluída' : o.estado === 'Concluída'))
    .sort((a, b) => (a.estado === 'Concluída') - (b.estado === 'Concluída') || a.prioridade - b.prioridade || b.ts - a.ts);
  const nv = (id) => S.veiculos.filter((v) => v.ocorrencia === id).length;
  $('#occ-list').innerHTML = arr.length ? arr.map((o) => `<button class="occ pr${o.prioridade}${o.estado === 'Concluída' ? ' done' : ''}${S.sel === o.id ? ' sel' : ''}" data-act="sel" data-id="${o.id}">
    <span class="bar"></span><span class="occ-main"><span class="occ-t">${esc(o.tipo)}</span>
    <span class="occ-m">${esc(o.morada || o.lat.toFixed(4) + ', ' + o.lng.toFixed(4))}</span>
    <span class="occ-f"><span class="tag ${stCls(o.estado)}">${esc(o.estado)}</span><span class="tag prio pr${o.prioridade}">${PRIO_OCC[o.prioridade]}</span>${o.sado ? `<span>SADO ${esc(o.sado)}</span>` : ''}<span>${nv(o.id)} meios</span><span>${hora(o.ts)}</span></span></span></button>`).join('')
    : `<p class="empty">${f === 'concluidas' ? 'Sem ocorrências concluídas nos últimos 7 dias.' : can('criarOcorr') ? 'Sem ocorrências ativas. Use Nova ocorrência para registar a primeira.' : 'Sem ocorrências ativas.'}</p>`;
}
async function loadRegs() {
  const id = S.sel; if (!id) return;
  try { const r = await api('GET', `/api/ocorrencias/${id}/registos`); if (S.sel === id) { S.regs = r; renderLog(); } } catch (e) {}
}
function select(id) {
  if (S.sel !== id) { S.sel = id; S.regs = []; $('#det-log').innerHTML = ''; loadRegs(); }
  $('#detail').hidden = false; renderDetail(); renderList(); renderMap();
  const o = S.O[id]; if (o && window.innerWidth > 860) Mapa.pan(o.lat, o.lng);
}
function closeDet() { S.sel = null; $('#detail').hidden = true; renderList(); renderMap(); }
function renderDetail() {
  const id = S.sel, o = S.O[id];
  if (!o) { closeDet(); return; }
  const mine = S.veiculos.filter((v) => v.ocorrencia === id), others = S.veiculos.filter((v) => v.ocorrencia !== id && v.estado !== 'Inoperacional');
  const ed = can('editarOcorr');
  const crewN = (vid) => S.membros.filter((m) => m.veiculo === vid && m.ativo).length;
  const nav = `https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}`;
  $('#det-body').innerHTML = `
  <div class="det-head pr${o.prioridade}">
    <div class="row"><span class="tag prio pr${o.prioridade}">Prioridade ${PRIO_OCC[o.prioridade]}</span><span class="tag ${stCls(o.estado)}">${esc(o.estado)}</span>${o.sado ? `<span class="tag">SADO ${esc(o.sado)}</span>` : ''}</div>
    <h2>${esc(o.tipo)}</h2>
    ${o.morada ? `<p class="det-addr">${esc(o.morada)}</p>` : ''}
    <p class="det-meta">Registada por ${esc(nm(o.por))} às ${hora(o.ts)}</p>
    <div class="det-links"><a href="${nav}" target="_blank" rel="noopener">Navegar até ao local</a><span class="coords">${o.lat.toFixed(5)}, ${o.lng.toFixed(5)}</span>${ed ? '<button class="linkbtn" data-act="editOcc">Editar dados</button>' : ''}</div>
  </div>
  ${o.descricao ? `<p class="det-desc">${esc(o.descricao)}</p>` : ''}
  ${ed ? `<div class="blk"><h3>Estado</h3><div class="row">${EST_OCC.map((e) => `<button class="btn" data-act="setEst" data-v="${e}" aria-pressed="${o.estado === e}">${e}</button>`).join('')}
    <select class="inp" data-chg="setPrio" aria-label="Prioridade" style="margin-left:auto">${[1, 2, 3].map((p) => `<option value="${p}"${o.prioridade === p ? ' selected' : ''}>Prioridade ${PRIO_OCC[p]}</option>`).join('')}</select></div></div>` : ''}
  <div class="blk"><h3>Meios no local</h3>
    <div class="row">${mine.length ? mine.map((v) => `<span class="chip">${esc(v.sigla)} <small style="font-weight:400;color:var(--muted)">${crewN(v.id)} el.</small>${ed ? `<button data-act="unassign" data-id="${v.id}" aria-label="Retirar ${esc(v.sigla)}">×</button>` : ''}</span>`).join('') : '<span class="coords">Nenhum meio atribuído.</span>'}</div>
    ${ed ? (others.length ? `<div class="row" style="margin-top:10px"><select id="as-vei" class="inp">${others.map((v) => `<option value="${v.id}">${esc(v.sigla)} (${v.ocorrencia ? 'noutra ocorrência' : esc(v.estado)})</option>`).join('')}</select><button class="btn primary" data-act="assign">Atribuir meio</button></div>` : '<p class="coords" style="margin:8px 0 0">Não há meios operacionais por atribuir.</p>') : ''}
  </div>
  ${can('apagarOcorr') ? '<div class="blk"><button class="btn danger" data-act="delOcc">Eliminar ocorrência</button></div>' : ''}`;
  renderLog();
}
function renderLog() {
  if (!S.sel) return;
  $('#det-log').innerHTML = S.regs.length ? S.regs.map((r) => r.tipo === 'estado'
    ? `<li class="sys">${hora(r.ts)} ${esc(r.texto)} (${esc(nm(r.por))})</li>`
    : `<li><div class="who"><b>${esc(nm(r.por))}</b> ${postoTag(r.por)} ${hora(r.ts)}</div>${r.texto ? `<p>${esc(r.texto)}</p>` : ''}${r.foto ? `<img src="/fotos/${esc(r.foto)}" alt="Foto da ocorrência" loading="lazy" data-act="lb" data-src="/fotos/${esc(r.foto)}">` : ''}</li>`).join('')
    : '<li class="sys">Sem registos.</li>';
}
async function compress(file) {
  try {
    const bmp = await createImageBitmap(file); const sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob((b) => r(b || file), 'image/jpeg', 0.8));
  } catch (e) { return file; }
}
$('#photo-in').addEventListener('change', async (e) => {
  const files = [...e.target.files]; e.target.value = ''; const occ = S.sel; if (!files.length || !occ) return;
  const cap = $('#note-txt').value.trim(), st = $('#up-status'); let ok = 0;
  for (let i = 0; i < files.length; i++) {
    st.textContent = `A enviar foto ${i + 1} de ${files.length}…`;
    try { const b = await compress(files[i]); await api('POST', `/api/ocorrencias/${occ}/fotos`, undefined, { body: b, type: b.type || 'image/jpeg', headers: { 'X-Legenda': encodeURIComponent(cap) } }); ok++; }
    catch (er) { toast(er.message, 1); }
  }
  st.textContent = '';
  if (ok) { toast(ok > 1 ? ok + ' fotos adicionadas' : 'Foto adicionada'); if (cap) $('#note-txt').value = ''; }
});

/* ---------------- meios e arrastar/largar (drag & drop) ---------------- */
let draggedMemberId = null;
let touchGhost = null;

async function assignMember(memberId, vehicleId) {
  const m = S.M[memberId];
  const v = S.V[vehicleId];
  if (!m || !v) return;
  const prevVehicle = m.veiculo;
  if (prevVehicle === vehicleId) return;

  // Optimistic update
  m.veiculo = vehicleId;
  if (S.me?.id === memberId) S.me.veiculo = vehicleId;
  S.selectedMemberForAssign = null;
  renderMeios();
  renderHeader();
  renderOpBanner();

  try {
    await api('POST', `/api/veiculos/${vehicleId}/tripulacao`, { membro: memberId });
    toast(`${m.nome} atribuído a ${v.sigla}`);
  } catch (err) {
    m.veiculo = prevVehicle;
    if (S.me?.id === memberId) S.me.veiculo = prevVehicle;
    renderMeios();
    renderHeader();
    renderOpBanner();
    toast(err.message, 1);
  }
}

async function unassignMember(memberId) {
  const m = S.M[memberId];
  if (!m) return;
  const prevVehicle = m.veiculo;
  if (!prevVehicle) return;

  // Optimistic update
  m.veiculo = null;
  if (S.me?.id === memberId) S.me.veiculo = null;
  S.selectedMemberForAssign = null;
  renderMeios();
  renderHeader();
  renderOpBanner();

  try {
    await api('DELETE', `/api/tripulacao/${memberId}`);
    toast(`${m.nome} retirado da viatura`);
  } catch (err) {
    m.veiculo = prevVehicle;
    if (S.me?.id === memberId) S.me.veiculo = prevVehicle;
    renderMeios();
    renderHeader();
    renderOpBanner();
    toast(err.message, 1);
  }
}

function setupDragAndDrop() {
  // Desktop HTML5 Drag & Drop
  document.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.drag-item');
    if (!item || !can('gerirTrip')) return;
    draggedMemberId = +item.dataset.dragMember;
    e.dataTransfer.setData('text/plain', String(draggedMemberId));
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('is-dragging');
  });

  document.addEventListener('dragend', (e) => {
    const item = e.target.closest('.drag-item');
    if (item) item.classList.remove('is-dragging');
    $$('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    draggedMemberId = null;
  });

  document.addEventListener('dragover', (e) => {
    if (!draggedMemberId) return;
    const dropZone = e.target.closest('[data-drop-vei], [data-drop-unassign]');
    if (dropZone) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.drag-over').forEach((el) => { if (el !== dropZone) el.classList.remove('drag-over'); });
      dropZone.classList.add('drag-over');
    } else {
      $$('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    }
  });

  document.addEventListener('dragleave', (e) => {
    const dropZone = e.target.closest('[data-drop-vei], [data-drop-unassign]');
    if (dropZone && !dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('drag-over');
    }
  });

  document.addEventListener('drop', (e) => {
    const dropZone = e.target.closest('[data-drop-vei], [data-drop-unassign]');
    if (!dropZone || !draggedMemberId) return;
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const mid = draggedMemberId;
    draggedMemberId = null;
    if (dropZone.dataset.dropVei) {
      assignMember(mid, +dropZone.dataset.dropVei);
    } else if (dropZone.dataset.dropUnassign) {
      unassignMember(mid);
    }
  });

  // Touch Support (smartphones and tablets)
  let touchStartX = 0, touchStartY = 0, touchItem = null, isTouching = false;
  document.addEventListener('touchstart', (e) => {
    if (!can('gerirTrip')) return;
    const item = e.target.closest('.drag-item');
    if (!item) return;
    touchItem = item;
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    isTouching = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!touchItem) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - touchStartX);
    const dy = Math.abs(t.clientY - touchStartY);
    if (!isTouching && (dx > 12 || dy > 12)) {
      isTouching = true;
      const mid = +touchItem.dataset.dragMember;
      draggedMemberId = mid;
      touchItem.classList.add('is-dragging');
      touchGhost = document.createElement('div');
      touchGhost.className = 'touch-ghost';
      touchGhost.textContent = `🚒 ${S.M[mid]?.nome || 'Elemento'}`;
      document.body.appendChild(touchGhost);
    }
    if (isTouching && touchGhost) {
      e.preventDefault();
      touchGhost.style.left = t.clientX + 'px';
      touchGhost.style.top = t.clientY + 'px';
      const target = document.elementFromPoint(t.clientX, t.clientY);
      const dropZone = target?.closest('[data-drop-vei], [data-drop-unassign]');
      $$('.drag-over').forEach((el) => { if (el !== dropZone) el.classList.remove('drag-over'); });
      if (dropZone) dropZone.classList.add('drag-over');
    }
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (!touchItem) return;
    if (isTouching && draggedMemberId) {
      const t = e.changedTouches[0];
      const target = document.elementFromPoint(t.clientX, t.clientY);
      const dropZone = target?.closest('[data-drop-vei], [data-drop-unassign]');
      const mid = draggedMemberId;
      if (dropZone) {
        if (dropZone.dataset.dropVei) assignMember(mid, +dropZone.dataset.dropVei);
        else if (dropZone.dataset.dropUnassign) unassignMember(mid);
      }
    }
    if (touchGhost) { touchGhost.remove(); touchGhost = null; }
    if (touchItem) { touchItem.classList.remove('is-dragging'); touchItem = null; }
    $$('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    draggedMemberId = null;
    isTouching = false;
  });
}

function busy(el) { const a = document.activeElement; if (el.contains(a) && a.tagName === 'SELECT') { S.dirty = true; return true; } return false; }

function renderMeios() {
  const el = $('#meios-list'); if (busy(el)) return;
  $('#add-vei').hidden = !can('gerirVei');
  const gt = can('gerirTrip'), ativos = S.membros.filter((m) => m.ativo);
  const livres = ativos.filter((m) => !m.veiculo);
  const atrib = ativos.filter((m) => m.veiculo);

  // Render quick stats
  const statsEl = $('#meios-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="m-stat"><b>${S.veiculos.length}</b><span>Viaturas</span></div>
      <div class="m-stat"><b>${atrib.length}</b><span>Tripulantes</span></div>
      <div class="m-stat ${livres.length ? 'crit' : ''}"><b>${livres.length}</b><span>Sem viatura</span></div>`;
  }

  // Render quick add buttons
  const qb = $('#quick-vei-btns');
  if (qb && !qb.children.length && can('gerirVei')) {
    const tipos = ['VFCI', 'VUCI', 'VLCI', 'ABSC', 'VCOT', 'VSAT', 'VTPT'];
    qb.innerHTML = tipos.map((t) => `<button type="button" class="quick-btn" data-act="quickAddVei" data-tipo="${t}">+ ${t}</button>`).join('');
  }

  const selMem = S.selectedMemberForAssign && S.M[S.selectedMemberForAssign];

  const card = (v) => {
    const o = v.ocorrencia && S.O[v.ocorrencia];
    const cls = v.estado === 'Em ocorrência' ? 'st-em' : v.estado === 'Inoperacional' ? 'st-inop' : '';
    const crew = ativos.filter((m) => m.veiculo === v.id);
    return `<article class="vei ${cls}" data-drop-vei="${v.id}">
      <header>
        <span class="st"></span>
        <div><h3>${esc(v.sigla)}</h3><span class="tipo">${esc(v.tipo)}</span></div>
        <div class="r">${gt ? `<select class="inp" data-chg="veiEstado" data-id="${v.id}" aria-label="Estado de ${esc(v.sigla)}">${EST_VEI.map((e) => `<option${e === v.estado ? ' selected' : ''}${e === 'Em ocorrência' && !v.ocorrencia ? ' disabled' : ''}>${e}</option>`).join('')}</select>` : `<span class="tag">${esc(v.estado)}</span>`}</div>
      </header>
      <div class="occlnk">${o ? `<button class="linkbtn" data-act="goOcc" data-id="${v.ocorrencia}">🚨 ${esc(o.tipo)}${o.morada ? ', ' + esc(o.morada) : ''}</button>` : '<span class="coords">Sem ocorrência atribuída</span>'}</div>
      <div class="drop-helper">➕ Largar para adicionar a ${esc(v.sigla)}</div>
      <ul class="crew">${crew.length ? crew.map((m) => `
        <li class="drag-item" draggable="${gt}" data-drag-member="${m.id}" data-from-vei="${v.id}">
          ${gt ? '<span class="drag-handle" title="Arrastar">⠿</span>' : ''}
          <span class="dot ${dotCls(m.estado)}" title="${esc(m.estado)}"></span>
          <span style="font-weight:600">${esc(m.nome)}</span> ${postoTag(m.id)}
          ${gt ? `<button class="btn ghost x" data-act="crewDel" data-id="${v.id}" data-u="${m.id}" aria-label="Retirar ${esc(m.nome)}" title="Retirar da viatura">×</button>` : ''}
        </li>`).join('') : '<li class="none">Sem tripulação (arrasta bombeiros para aqui)</li>'}
      </ul>
      ${(gt || can('gerirVei')) ? `<footer>
        ${gt && selMem ? `<button class="quick-assign-btn" data-act="assignSelectedTo" data-id="${v.id}">Atribuir ${esc(selMem.nome.split(' ')[0])} ↵</button>` : ''}
        ${can('gerirVei') ? `<button class="btn danger" data-act="delVei" data-id="${v.id}">Remover veículo</button>` : ''}
      </footer>` : ''}
    </article>`;
  };

  const poolHtml = livres.length ? livres.map((m) => `
    <div class="bom-chip drag-item ${S.selectedMemberForAssign === m.id ? 'selected-to-assign' : ''}" draggable="${gt}" data-drag-member="${m.id}" data-act="toggleSelectMember" data-id="${m.id}" title="${gt ? 'Arrasta para uma viatura ou clica para selecionar' : ''}">
      ${gt ? '<span class="drag-handle">⠿</span>' : ''}
      <span class="dot ${dotCls(m.estado)}" title="${esc(m.estado)}"></span>
      <b>${esc(m.nome)}</b> ${postoTag(m.id)}
      <small style="color:var(--muted)">${esc(m.estado)}</small>
    </div>`).join('') : '<p class="coords" style="padding:10px 12px">Todos os elementos ativos estão distribuídos pelas viaturas.</p>';

  el.innerHTML = (S.veiculos.length ? `<div class="vgrid">${S.veiculos.map(card).join('')}</div>` : `<p class="empty" style="padding:0">${can('gerirVei') ? 'Ainda não há veículos. Adiciona o primeiro acima ou usa o botão "Gerar Lote para Temporal".' : 'Ainda não há veículos registados.'}</p>`) +
    `<div class="sect">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3>Elementos sem veículo (${livres.length})</h3>
        ${selMem ? `<span class="coords">Selecionado: <b>${esc(selMem.nome)}</b> (clica numa viatura para atribuir) <button class="btn ghost" data-act="cancelSelect" style="padding:2px 6px">Cancelar</button></span>` : (gt ? '<span class="coords">Arrasta para um veículo ou clica para selecionar</span>' : '')}
      </div>
      <div class="unassigned-zone" data-drop-unassign="1">
        <div class="drop-unassign-helper">➕ Largar aqui para retirar da viatura</div>
        <div class="bom-pool">${poolHtml}</div>
      </div>
    </div>`;
}

/* ---------------- chat ---------------- */
function renderChat() {
  const el = $('#msgs'); const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  const arr = S.msgs.filter((m) => (m.prioridade || 0) >= S.chatFilter);
  el.innerHTML = arr.length ? arr.map((m) => {
    const p = m.prioridade || 0, o = m.ocorrencia && S.O[m.ocorrencia];
    return `<div class="msg p${p}${m.por === S.me.id ? ' mine' : ''}"><div class="msg-h"><b>${esc(nm(m.por))}</b>${postoTag(m.por)}${p ? `<span class="ptag p${p}">${PRIO_MSG[p]}</span>` : ''}${o ? `<button class="linkbtn" data-act="goOcc" data-id="${m.ocorrencia}">${esc(o.tipo)}${o.morada ? ', ' + esc(o.morada) : ''}</button>` : ''}<time>${hora(m.ts)}</time></div><div class="msg-b">${esc(m.texto)}</div></div>`;
  }).join('') : `<p class="empty">${S.chatFilter ? 'Sem mensagens com esta prioridade.' : 'Ainda não há mensagens. Escreva a primeira abaixo.'}</p>`;
  if (near || S.forceBottom) { el.scrollTop = el.scrollHeight; S.forceBottom = false; }
  const sel = $('#chat-occ'), cur = sel.value;
  const ativas = S.ocorr.filter((o) => o.estado !== 'Concluída').sort((a, b) => a.prioridade - b.prioridade);
  if (document.activeElement !== sel) {
    sel.innerHTML = '<option value="">Sem ocorrência</option>' + ativas.map((o) => `<option value="${o.id}">${esc(o.tipo)}${o.morada ? ', ' + esc(o.morada) : ''}</option>`).join('');
    sel.value = ativas.some((o) => String(o.id) === cur) ? cur : '';
  }
  S.chatSeen = Date.now();
}
function paintPrio() {
  $$('.prio-pick button').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.v === S.msgPrio));
  const s = $('#send-btn'); s.classList.toggle('p3', S.msgPrio === 3); s.textContent = S.msgPrio === 3 ? 'Enviar alerta' : 'Enviar';
}
async function sendMsg() {
  const t = $('#chat-txt'), texto = t.value.trim(); if (!texto) return;
  t.value = ''; S.forceBottom = true;
  if (!(await W(api('POST', '/api/mensagens', { texto, prioridade: S.msgPrio, ocorrencia: +$('#chat-occ').value || null })))) t.value = texto;
  else { S.msgPrio = 0; paintPrio(); }
}
function alertMsg(m) {
  const p = m.prioridade || 0;
  if (p === 3) { $('#alert-txt').textContent = `${nm(m.por)}: ${m.texto}`; $('#alert').hidden = false; beep(4, 980); document.title = 'EMERGÊNCIA | Sala de Operações'; }
  else if (p === 2) { beep(2, 820); if (S.tab !== 'chat') toast(`Urgente de ${nm(m.por)}: ${m.texto}`); }
  else if (p === 1 && S.tab !== 'chat') beep(1, 700);
}

/* ---------------- elementos ---------------- */
const postosGeriveis = () => Object.entries(POSTOS).filter(([k]) => S.me.posto === 'central' || POSTOS[k].r <= 2);
function renderElementos() {
  const el = $('#el-list'); if (busy(el)) return;
  const g = can('gerirContas');
  $('#el-new').hidden = !g;
  if (g && !$('#nm-posto').options.length) $('#nm-posto').innerHTML = postosGeriveis().map(([k, v]) => `<option value="${k}">${v.n}</option>`).join('');
  const podeEste = (m) => g && m.id !== S.me.id && (S.me.posto === 'central' || POSTOS[m.posto].r <= 2);
  const sorted = [...S.membros].sort((a, b) => POSTOS[b.posto].r - POSTOS[a.posto].r || a.nome.localeCompare(b.nome));
  const row = (m) => `<div class="lrow${m.ativo ? '' : ' off'}">
    <span class="dot ${dotCls(m.estado)}"></span><span class="nm">${esc(m.nome)}${m.id === S.me.id ? ' (eu)' : ''}</span>
    <span class="sub">${esc(m.utilizador)}${m.numero ? ', n.º ' + esc(m.numero) : ''}</span>
    <span class="sub">${m.ativo ? esc(m.estado) + (m.veiculo ? ', ' + esc(S.V[m.veiculo]?.sigla || '') : '') : 'Conta desativada'}</span>
    <span class="r">${podeEste(m) ? `${m.ativo ? `<select class="inp" data-chg="posto" data-id="${m.id}" aria-label="Posto de ${esc(m.nome)}">${postosGeriveis().map(([k, v]) => `<option value="${k}"${m.posto === k ? ' selected' : ''}>${v.n}</option>`).join('')}</select>
      <button class="btn" data-act="resetPw" data-id="${m.id}">Repor palavra-passe</button>
      <button class="btn danger" data-act="toggleAtivo" data-id="${m.id}">Desativar</button>` : `<button class="btn" data-act="toggleAtivo" data-id="${m.id}">Reativar</button>`}` : postoTag(m.id)}</span></div>`;
  const ativos = sorted.filter((m) => m.ativo), inativos = sorted.filter((m) => !m.ativo);
  el.innerHTML = `<div class="sect"><h3>Elementos ativos (${ativos.length})</h3><div class="list">${ativos.map(row).join('')}</div></div>
    ${inativos.length && g ? `<div class="sect"><h3>Contas desativadas</h3><div class="list">${inativos.map(row).join('')}</div></div>` : ''}
    <div class="sect"><h3>Permissões por posto</h3><div class="list">
    <div class="lrow"><span class="posto bombeiro">Bombeiro</span><span class="sub">Vê ocorrências e meios, adiciona notas e fotos, usa o chat, atualiza o seu estado.</span></div>
    <div class="lrow"><span class="posto chefe">Chefe</span><span class="sub">Também regista e edita ocorrências, muda estado e prioridade, atribui meios e gere tripulações.</span></div>
    <div class="lrow"><span class="posto comando">Comando</span><span class="sub">Também cria e remove veículos, elimina ocorrências e gere contas de Bombeiros e Chefes.</span></div>
    <div class="lrow"><span class="posto central">Central</span><span class="sub">Acesso total: todas as contas e a configuração da app.</span></div></div></div>`;
}
function showCred(nome, user, pw) {
  const c = $('#cred'); c.hidden = false;
  c.innerHTML = `<b>Dados de acesso de ${esc(nome)}</b><p style="margin:6px 0 0">Utilizador <code>${esc(user)}</code> e palavra-passe temporária <code>${esc(pw)}</code>. Entrega-os em mão ou por canal seguro. No primeiro login vai ser pedida uma nova palavra-passe.</p><div class="row" style="margin-top:8px"><button class="btn" data-act="hideCred">Já entreguei, esconder</button></div>`;
  c.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ---------------- configuração ---------------- */
function applyCfg() {
  document.body.classList.toggle('is-central', can('config'));
  $('#corp').textContent = S.cfg.corporacao || '';
  $('#gate-sub').textContent = S.cfg.corporacao || 'Coordenação de ocorrências';
  if (!$('#dlg-occ').open) $('#f-tipo').innerHTML = opts(S.cfg.tiposOcorrencia);
  $('#nv-tipo').innerHTML = opts(S.cfg.tiposVeiculo);
}
function renderConfig() {
  if (!can('config')) return;
  const f = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  f('#cf-corp', S.cfg.corporacao || ''); f('#cf-tocc', S.cfg.tiposOcorrencia.join('\n')); f('#cf-tvei', S.cfg.tiposVeiculo.join('\n'));
}

/* ---------------- cabeçalho e separadores ---------------- */
function renderHeader() {
  $('#me-nome').textContent = S.me.nome;
  const p = $('#me-posto'); p.textContent = POSTOS[S.me.posto]?.n || ''; p.className = 'posto ' + S.me.posto;
  const s = $('#me-estado'); if (document.activeElement !== s) s.innerHTML = opts(EST_EL, S.me.estado);
  if (!S.picking) $('#btn-new').hidden = !can('criarOcorr');

  // Badge da viatura atribuída
  const vTag = $('#me-veiculo-tag');
  if (vTag) {
    const vid = S.me?.veiculo;
    const v = vid && S.V[vid];
    if (v) {
      const isEm = v.estado === 'Em ocorrência';
      vTag.className = 'me-vei-badge' + (isEm ? ' em-ocorr' : '');
      vTag.innerHTML = `🚒 <span>${esc(v.sigla)}</span>${isEm ? ' <small style="font-weight:400;opacity:.85">(Em curso)</small>' : ''}`;
      vTag.setAttribute('data-act', 'myVeiClick');
      vTag.title = `Estás designado ao veículo ${v.sigla} (${v.tipo}). Clica para ver.`;
    } else {
      vTag.className = 'me-vei-badge sem-vei';
      vTag.innerHTML = `<span>⚠️ Sem viatura</span>`;
      vTag.setAttribute('data-act', 'myVeiClick');
      vTag.title = 'Ainda não tens viatura designada. Clica para ver os Meios.';
    }
  }
}

function renderOpBanner() {
  const banner = $('#op-banner');
  if (!banner || !S.me) return;
  if (S.dismissedOpBanner) { banner.hidden = true; return; }
  const vid = S.me.veiculo;
  const v = vid && S.V[vid];
  banner.hidden = false;
  if (v) {
    $('#op-vei-sigla').textContent = v.sigla;
    const occ = v.ocorrencia && S.O[v.ocorrencia];
    $('#op-vei-tipo').textContent = `${v.tipo} • ${v.estado}`;
    $('#op-vei-tipo').className = 'tag ' + (v.estado === 'Em ocorrência' ? 'st-curso' : 'st-aberta');
    const crew = S.membros.filter((m) => m.veiculo === v.id && m.ativo);
    const crewNames = crew.map((m) => (m.id === S.me.id ? `<b>${esc(m.nome)} (tu)</b>` : esc(m.nome))).join(', ');
    $('#op-vei-crew').innerHTML = `<b>Tripulação (${crew.length}):</b> ${crewNames || 'Sem outros elementos'}`;
    let act = `<button class="btn" data-act="tab" data-v="meios">Ver Meios & Tripulações</button>`;
    if (occ) act = `<button class="btn red" data-act="goOcc" data-id="${occ.id}">🚨 Ocorrência Atribuída (${esc(occ.tipo)})</button>` + act;
    $('#op-vei-actions').innerHTML = act;
  } else {
    $('#op-vei-sigla').textContent = 'Nenhuma';
    $('#op-vei-tipo').textContent = 'Aguardar Distribuição';
    $('#op-vei-tipo').className = 'tag';
    $('#op-vei-crew').textContent = can('gerirTrip')
      ? 'És Chefe/Comando/Central: acede a Meios para gerar veículos e arrastar bombeiros.'
      : 'Ainda não tens viatura designada para o temporal. Aguarda distribuição pelo teu Chefe.';
    $('#op-vei-actions').innerHTML = can('gerirTrip') ? `<button class="btn primary" data-act="tab" data-v="meios">Distribuir Viaturas</button>` : '';
  }
}

function renderBadges() {
  const n = S.tab === 'chat' ? 0 : S.msgs.filter((m) => m.ts > S.chatSeen && m.por !== S.me.id).length;
  $$('.b-chat').forEach((b) => { b.hidden = !n; b.textContent = n > 99 ? '99+' : n; });
}
function render() {
  if (!S.me || $('#main').hidden) return;
  renderHeader(); renderOpBanner(); renderMap(); renderList(); if (S.sel) renderDetail();
  if (S.tab === 'meios') renderMeios();
  if (S.tab === 'chat') renderChat();
  if (S.tab === 'elementos') renderElementos();
  if (S.tab === 'config') renderConfig();
  renderBadges();
}
function setTab(t) {
  if (t === 'config' && !can('config')) t = 'mapa';
  S.tab = t; $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + t));
  $$('[data-act="tab"]').forEach((b) => b.setAttribute('aria-current', b.dataset.v === t));
  if (t !== 'mapa' && S.picking) stopPick();
  if (t === 'chat') { S.forceBottom = true; document.title = 'Sala de Operações'; }
  if (t === 'mapa') Mapa.resize();
  render();
}

/* ---------------- ações ---------------- */
const ACT = {
  tab: (_, b) => setTab(b.dataset.v),
  logout: () => logout(),
  sel: (id) => select(+id),
  closeDet: () => closeDet(),
  filter: (_, b) => { S.filter = b.dataset.v; $$('[data-act="filter"]').forEach((x) => x.setAttribute('aria-pressed', x === b)); renderList(); renderMap(); },
  newOcc: () => { resetDlg(); startPick(); },
  pickGeo: () => geo((ll) => placePick(ll)),
  pickCancel: () => { stopPick(); if (S.editing) openDlg(); },
  occSave: () => saveOcc(),
  occCancel: () => { $('#dlg-occ').close(); resetDlg(); stopPick(); },
  occRepick: () => { $('#dlg-occ').close(); if (S.tab !== 'mapa') setTab('mapa'); S.picking = true; $('#pickbar').hidden = false; $('#btn-new').hidden = true; if (window.innerWidth <= 860) $('#detail').hidden = true; },
  editOcc: () => { resetDlg(); S.editing = S.sel; const o = S.O[S.sel]; Mapa.setPick({ lat: o.lat, lng: o.lng }); openDlg(); },
  setEst: (_, b) => W(api('PATCH', '/api/ocorrencias/' + S.sel, { estado: b.dataset.v })),
  assign: () => { const v = +$('#as-vei')?.value; if (v) W(api('PATCH', '/api/veiculos/' + v, { ocorrencia: S.sel })); },
  unassign: (id) => W(api('PATCH', '/api/veiculos/' + id, { ocorrencia: null })),
  delOcc: async (_, b) => { if (!arm(b)) return; if (await W(api('DELETE', '/api/ocorrencias/' + S.sel))) { closeDet(); toast('Ocorrência eliminada'); } },
  addNote: async () => { const t = $('#note-txt'), x = t.value.trim(); if (!x || !S.sel) return; if (await W(api('POST', `/api/ocorrencias/${S.sel}/notas`, { texto: x }))) t.value = ''; },
  lb: (_, b) => { $('#lb-img').src = b.dataset.src; $('#lb').hidden = false; },
  lbClose: () => { $('#lb').hidden = true; $('#lb-img').removeAttribute('src'); },
  msgPrio: (_, b) => { S.msgPrio = +b.dataset.v; paintPrio(); },
  chatFilter: (_, b) => { S.chatFilter = +b.dataset.v; $$('[data-act="chatFilter"]').forEach((x) => x.setAttribute('aria-pressed', x === b)); renderChat(); },
  send: () => sendMsg(),
  goOcc: (id) => {
    const o = S.O[+id]; if (!o) { toast('Esta ocorrência já não está disponível.', 1); return; }
    if (S.filter === 'ativas' && o.estado === 'Concluída') { S.filter = 'todas'; $$('[data-act="filter"]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.v === 'todas')); }
    setTab('mapa'); select(+id);
  },
  addVei: async () => {
    const s = $('#nv-sigla').value.trim(); if (!s) { toast('Indica a sigla do veículo.', 1); return; }
    if (await W(api('POST', '/api/veiculos', { sigla: s, tipo: $('#nv-tipo').value }))) { $('#nv-sigla').value = ''; toast('Veículo ' + s.toUpperCase() + ' adicionado'); }
  },
  quickAddVei: async (tipo, b) => {
    const t = b?.dataset.tipo || tipo;
    if (!t) return;
    const re = new RegExp(`^${t}\\s*(\\d+)`, 'i');
    let maxN = 0;
    for (const v of S.veiculos) {
      const m = v.sigla.match(re);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    const nextSigla = `${t} ${String(maxN + 1).padStart(2, '0')}`;
    if (await W(api('POST', '/api/veiculos', { sigla: nextSigla, tipo: t }))) {
      toast(`Veículo ${nextSigla} criado com sucesso!`);
    }
  },
  genStormBatch: async () => {
    const batch = [
      { sigla: 'VFCI 01', tipo: 'VFCI' },
      { sigla: 'VFCI 02', tipo: 'VFCI' },
      { sigla: 'VUCI 01', tipo: 'VUCI' },
      { sigla: 'VLCI 01', tipo: 'VLCI' },
      { sigla: 'ABSC 01', tipo: 'ABSC' },
      { sigla: 'VCOT 01', tipo: 'VCOT' },
      { sigla: 'VSAT 01', tipo: 'VSAT' }
    ];
    try {
      const res = await api('POST', '/api/veiculos/lote', { veiculos: batch });
      toast(`Lote criado: ${res.criados} novas viaturas operacionais prontas para o temporal.`);
    } catch (e) {
      toast(e.message, 1);
    }
  },
  delVei: async (id, b) => { if (arm(b)) W(api('DELETE', '/api/veiculos/' + id)); },
  crewAdd: (id) => { const u = +$('#cr-' + id)?.value; if (u) assignMember(u, +id); },
  crewDel: (id, b) => unassignMember(+b.dataset.u),
  dismissOpBanner: () => { S.dismissedOpBanner = true; const b = $('#op-banner'); if (b) b.hidden = true; },
  myVeiClick: () => {
    const vid = S.me?.veiculo;
    const v = vid && S.V[vid];
    if (v?.ocorrencia && S.O[v.ocorrencia]) ACT.goOcc(v.ocorrencia);
    else setTab('meios');
  },
  toggleSelectMember: (id) => {
    if (!can('gerirTrip')) return;
    const nid = +id;
    S.selectedMemberForAssign = S.selectedMemberForAssign === nid ? null : nid;
    renderMeios();
  },
  cancelSelect: () => { S.selectedMemberForAssign = null; renderMeios(); },
  assignSelectedTo: (vid) => {
    if (S.selectedMemberForAssign && vid) assignMember(S.selectedMemberForAssign, +vid);
  },
  genPw: () => { $('#nm-pw').value = genPw(); },
  createMember: async () => {
    const d = { nome: $('#nm-nome').value.trim(), numero: $('#nm-num').value.trim(), utilizador: $('#nm-user').value.trim().toLowerCase(), posto: $('#nm-posto').value, password: $('#nm-pw').value };
    if (!d.password) d.password = $('#nm-pw').value = genPw();
    if (await W(api('POST', '/api/membros', d))) { showCred(d.nome, d.utilizador, d.password); ['#nm-nome', '#nm-num', '#nm-user', '#nm-pw'].forEach((s) => ($(s).value = '')); }
  },
  hideCred: () => { $('#cred').hidden = true; $('#cred').innerHTML = ''; },
  resetPw: async (id, b) => {
    if (!arm(b)) return; const pw = genPw(), m = S.M[id];
    if (await W(api('PATCH', '/api/membros/' + id, { password: pw }))) showCred(m.nome, m.utilizador, pw);
  },
  toggleAtivo: async (id, b) => { const m = S.M[id]; if (m.ativo && !arm(b)) return; W(api('PATCH', '/api/membros/' + id, { ativo: !m.ativo })); },
  changePw: async () => {
    if (await W(api('POST', '/api/password', { atual: $('#pw-old').value, nova: $('#pw-new').value }))) { $('#pw-old').value = $('#pw-new').value = ''; toast('Palavra-passe alterada. As outras sessões foram terminadas.'); }
  },
  saveCfg: async () => {
    const lines = (s) => $(s).value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (await W(api('PUT', '/api/config', { corporacao: $('#cf-corp').value, tiposOcorrencia: lines('#cf-tocc'), tiposVeiculo: lines('#cf-tvei') }))) toast('Configuração guardada');
  },
  saveView: async () => { const v = Mapa.view(); if (!v) return; if (await W(api('PUT', '/api/config', { mapaCentro: v }))) toast('Vista inicial do mapa guardada'); },
  alertChat: () => { $('#alert').hidden = true; document.title = 'Sala de Operações'; S.chatFilter = 0; $$('[data-act="chatFilter"]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.v === '0')); setTab('chat'); },
  alertOk: () => { $('#alert').hidden = true; document.title = 'Sala de Operações'; },
};
const CHG = {
  myEstado: (_, el) => W(api('PUT', '/api/me/estado', { estado: el.value })),
  setPrio: (_, el) => W(api('PATCH', '/api/ocorrencias/' + S.sel, { prioridade: +el.value })),
  veiEstado: (id, el) => W(api('PATCH', '/api/veiculos/' + id, { estado: el.value })),
  posto: (id, el) => W(api('PATCH', '/api/membros/' + id, { posto: el.value })),
};
document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && ACT[b.dataset.act]) ACT[b.dataset.act](b.dataset.id, b, e); });
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-chg]'); if (el && CHG[el.dataset.chg]) CHG[el.dataset.chg](el.dataset.id, el);
  if (S.dirty) { S.dirty = false; setTimeout(render, 0); }
});
document.addEventListener('focusout', () => { if (S.dirty) setTimeout(() => { if (S.dirty && document.activeElement?.tagName !== 'SELECT') { S.dirty = false; render(); } }, 0); });
$('#chat-txt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#lb').hidden) ACT.lbClose(); });
$('#dlg-occ').addEventListener('cancel', () => { resetDlg(); stopPick(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.started && es) scheduleLoad(); });

boot();
