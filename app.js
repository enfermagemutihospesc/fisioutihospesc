/* ══════════════════════════════════════════════════════════════
   SISTEMA FISIOTERAPIA UTI – HOSPESC
   Consome uti_leitos (compartilhado com enfermagem, somente leitura).
   Grava em fisio_ev_<leito>_<turno>_<data> (evolução).
   ══════════════════════════════════════════════════════════════ */

// ── FIREBASE ─────────────────────────────────────────────────────────────────
let app, db, auth;
let modoOffline = false;
try {
  app = firebase.initializeApp(FIREBASE_CONFIG);
  db  = firebase.firestore();
  auth = firebase.auth();
} catch(e) {
  console.error('Firebase falhou:', e);
  modoOffline = true;
}

// ── ESTADO GLOBAL ────────────────────────────────────────────────────────────
let turno = '', leitoAtual = 0, usuarioEmail = '';

// ── UTILITÁRIOS ──────────────────────────────────────────────────────────────
function pad(n){ return String(n).padStart(2,'0'); }
function hoje(){
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}
function fmtD(s){
  if (!s) return '';
  const [y,m,d] = s.split('-');
  return `${d}/${m}/${y}`;
}
function gf(id){ const el = document.getElementById(id); return el ? el.value : ''; }
function setF(id, v){
  const el = document.getElementById(id);
  if (el) el.value = v == null ? '' : v;
}
function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function toast(msg, erro=false){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (erro ? ' erro' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2800);
}
function showLoading(msg='Carregando...'){
  document.getElementById('loading-msg').textContent = msg;
  document.getElementById('loading-overlay').classList.add('show');
}
function hideLoading(){
  document.getElementById('loading-overlay').classList.remove('show');
}

// ── DB (Firestore + fallback localStorage) ───────────────────────────────────
// IMPORTANTE: usa o MESMO formato da enfermagem para poder ler uti_leitos.
// A enfermagem grava como: { value: <dados>, updatedAt: <timestamp> }
async function dbGet(key){
  if (!modoOffline && db) {
    try {
      const doc = await db.collection('uti').doc(key).get();
      if (doc.exists) {
        const data = doc.data();
        // Aceita tanto "value" (enfermagem) quanto "v" (caso alguma rodada antiga tenha gravado)
        const valor = data.value !== undefined ? data.value : data.v;
        if (valor !== undefined) {
          localStorage.setItem(key, JSON.stringify(valor));
          return valor;
        }
      }
    } catch(e) { console.warn('dbGet firestore:', e); }
  }
  const cached = localStorage.getItem(key);
  if (cached) try { return JSON.parse(cached); } catch(e){}
  return null;
}
async function dbSet(key, value){
  localStorage.setItem(key, JSON.stringify(value));
  if (!modoOffline && db) {
    try {
      // Usa o mesmo formato da enfermagem: { value: ..., updatedAt: ... }
      await db.collection('uti').doc(key).set({
        value,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch(e) { console.warn('dbSet firestore:', e); }
  }
}

// ── CHAVES ───────────────────────────────────────────────────────────────────
function evKey(leito, turno, data){
  return `fisio_ev_${leito}_${turno}_${data}`;
}

// ── DADOS DOS LEITOS (compartilhados com enfermagem, somente leitura) ────────
async function leitosData(){
  let d = await dbGet('uti_leitos');
  if (!d) {
    // Se não há dados (primeira vez), cria leitos vazios (mas não grava — só a enfermagem admite)
    d = {};
    for (let i = 1; i <= TOTAL; i++) {
      d[i] = { ocupado:false, pac:'', diag:'', dn:'', adm:'', admHosp:'', comor:'', alergia:'' };
    }
  }
  return d;
}

// ── NAVEGAÇÃO ────────────────────────────────────────────────────────────────
function mostrarTela(id){
  document.querySelectorAll('.tela').forEach(t => t.classList.remove('ativa'));
  ['t-login','t-turno'].forEach(tid => {
    const el = document.getElementById(tid);
    if (el) el.style.display = 'none';
  });
  const el = document.getElementById(id);
  if (!el) return;
  if (['t-login','t-turno'].includes(id)) el.style.display = 'flex';
  else el.classList.add('ativa');
}

function irTelaTurno(){
  mostrarTela('t-turno');
  const dot = document.getElementById('sync-dot');
  const txt = document.getElementById('sync-txt');
  if (modoOffline) {
    dot.className = 'sync-dot err';
    txt.textContent = 'modo offline – dados locais';
  } else {
    dot.className = 'sync-dot ok';
    txt.textContent = 'conectado ao Firebase';
  }
}
function irTurno(){ irTelaTurno(); }
function irLeitos(){ mostrarTela('t-leitos'); renderLeitos(); window.scrollTo(0,0); }
function irForm(){ mostrarTela('t-form'); window.scrollTo(0,0); }
function irPreview(){ mostrarTela('t-prev'); window.scrollTo(0,0); }

// ── AUTENTICAÇÃO ─────────────────────────────────────────────────────────────
async function fazerLogin(){
  const email = gf('li-email').trim();
  const senha = gf('li-senha');
  const errEl = document.getElementById('login-err');
  const btn = document.getElementById('btn-entrar');
  errEl.textContent = '';
  if (!email || !senha) { errEl.textContent = 'Preencha e-mail e senha.'; return; }
  btn.disabled = true; btn.textContent = 'Entrando...';
  try {
    await auth.signInWithEmailAndPassword(email, senha);
  } catch(e) {
    const msgs = {
      'auth/user-not-found':'Usuário não encontrado.',
      'auth/wrong-password':'Senha incorreta.',
      'auth/invalid-email':'E-mail inválido.',
      'auth/too-many-requests':'Muitas tentativas. Tente mais tarde.',
    };
    errEl.textContent = msgs[e.code] || 'Erro ao entrar.';
    btn.disabled = false; btn.textContent = 'Entrar';
  }
}

function fazerLogout(){
  if (!confirm('Sair do sistema?')) return;
  if (auth) auth.signOut();
  else irTelaTurno();
}

// ── TURNO ────────────────────────────────────────────────────────────────────
async function escolherTurno(t){
  turno = t;
  mostrarTela('t-leitos');
  const b = document.getElementById('badge-leitos');
  const mapa = { MANHA:'🌅 MANHÃ', TARDE:'☀ TARDE', NOITE:'🌙 NOITE' };
  b.textContent = mapa[t] || t;
  b.className = 'badge ' + (t === 'NOITE' ? 'badge-n' : 'badge-d');
  document.getElementById('badge-user').textContent = usuarioEmail
    ? '👤 ' + usuarioEmail.split('@')[0] + ' · Sair'
    : 'Sair';
  await renderLeitos();
}

// ── LEITOS ───────────────────────────────────────────────────────────────────
async function renderLeitos(){
  const grid = document.getElementById('leitos-grid');
  grid.innerHTML = '';
  const d = await leitosData();
  for (let i = 1; i <= TOTAL; i++) {
    const l = d[i] || { ocupado:false };
    // Verifica se já existe evolução deste turno/dia
    const ev = l.ocupado ? await dbGet(evKey(i, turno, hoje())) : null;

    const card = document.createElement('div');
    card.className = 'leito-card';
    if (l.ocupado) card.classList.add('ocupado');
    card.onclick = () => abrirLeito(i);
    card.innerHTML = `
      <div class="leito-num">LEITO ${pad(i)}</div>
      <div class="leito-info">${l.ocupado
        ? `<div class="leito-pac">${esc(l.pac||'–')}</div><div class="leito-diag">${esc(l.diag||'')}</div>`
        : `<div class="leito-vazio">Vago</div>`}
      </div>
      <div class="leito-badge-row">
        ${l.ocupado ? `<span class="lb lb-cloud">🏃 Fisio</span>` : ''}
        ${ev ? '<span class="lb lb-ok">✓ Evoluído</span>' : ''}
      </div>`;
    grid.appendChild(card);
  }
}

function abrirLeito(leito){
  leitosData().then(d => {
    const l = d[leito];
    if (!l || !l.ocupado) {
      toast('Leito vago — admissão deve ser feita pela enfermagem', true);
      return;
    }
    leitoAtual = leito;
    document.getElementById('modal-escolha-titulo').textContent =
      `Leito ${pad(leito)} – ${l.pac || 'Paciente'}`;
    document.getElementById('modal-escolha').classList.add('show');
  });
}

function fecharModalEscolha(){
  document.getElementById('modal-escolha').classList.remove('show');
}

function abrirEvolucao(){
  fecharModalEscolha();
  abrirForm(leitoAtual);
}

function abrirAcompanhamento(){
  fecharModalEscolha();
  toast('📊 Acompanhamento Diário — em construção', false);
}

// ── FORMULÁRIO DE EVOLUÇÃO ───────────────────────────────────────────────────
async function abrirForm(leito){
  leitoAtual = leito;
  const d = await leitosData();
  const l = d[leito];

  // Preenche dados fixos do leito
  setF('f-pac', l.pac || '');
  setF('f-leito', pad(leito));
  setF('f-data', hoje());
  setF('f-diag', (l.diag || '').toUpperCase());
  setF('f-sexo', l.sexo || '');

  // Calcula idade a partir da DN
  if (l.dn) {
    const [y, m, dd] = l.dn.split('-').map(Number);
    const dn = new Date(y, m-1, dd);
    const hj = new Date();
    let idade = hj.getFullYear() - dn.getFullYear();
    const mDiff = hj.getMonth() - dn.getMonth();
    if (mDiff < 0 || (mDiff === 0 && hj.getDate() < dn.getDate())) idade--;
    setF('f-idade', idade);
  }

  // Monta checkboxes de aspiração por turno
  _montarAspiracao();

  // Carrega evolução existente, se houver
  const ev = await dbGet(evKey(leito, turno, hoje()));
  if (ev) {
    _carregarDadosForm(ev);
    toast('📄 Evolução existente carregada');
  } else {
    // Limpa os campos editáveis (mas não os readonly)
    _limparCamposEditaveis();
    // Herda medicações do turno anterior (se houver)
    await _herdarMedicacoes(leito);
  }

  // Atualiza header
  document.getElementById('form-sub').textContent = `Leito ${pad(leito)} · ${_labelTurno(turno)} · ${fmtD(hoje())}`;
  const b = document.getElementById('badge-form');
  const mapa = { MANHA:'🌅 MANHÃ', TARDE:'☀ TARDE', NOITE:'🌙 NOITE' };
  b.textContent = mapa[turno] || turno;
  b.className = 'badge ' + (turno === 'NOITE' ? 'badge-n' : 'badge-d');

  toggleVMI();
  _ativarCaixaAlta();
  irForm();
}

function _labelTurno(t){
  return { MANHA:'Manhã', TARDE:'Tarde', NOITE:'Noite' }[t] || t;
}

function _montarAspiracao(){
  const cont = document.getElementById('asp-cg');
  cont.innerHTML = '';
  let horarios = [];
  if (turno === 'MANHA')      horarios = ['7h','8h','9h','10h','11h','12h'];
  else if (turno === 'TARDE') horarios = ['13h','14h','15h','16h','17h','18h'];
  else                         horarios = ['19-21h','21-23h','23-01h','01-03h','03-05h','05-07h'];
  horarios.forEach((h, i) => {
    const label = document.createElement('label');
    label.className = 'asp-c';
    label.innerHTML = `<input type="checkbox" id="f-asp-${i}" onchange="this.parentElement.classList.toggle('marcado',this.checked)"> ${h}`;
    cont.appendChild(label);
  });
  document.getElementById('asp-label').textContent =
    `Marque os horários do turno ${_labelTurno(turno)} em que foi realizada aspiração.`;
}

function _limparCamposEditaveis(){
  // Apenas campos editáveis — mantém identificação
  const ids = ['f-hfa','f-ap','f-gl','f-ect','f-mrc','f-jh',
    'f-fc','f-fr','f-pa','f-spo2','f-temp',
    'f-vmodo','f-vt','f-cest','f-pcps','f-vfr','f-raw','f-peep',
    'f-vm','f-ppt','f-fio2','f-tins','f-dp','f-fluxo','f-ie','f-apeep',
    'f-cn-lmin','f-mv-fio2','f-mnr-lmin',
    'f-dtot','f-dtqt','f-extb','f-reiot',
    'f-cr','f-cm','f-obs'
  ];
  ids.forEach(id => setF(id, ''));
  // MRC
  ['ombro','cotov','punho','quad','joel','dors'].forEach(g => {
    setF(`f-mrc-${g}-d`, '');
    setF(`f-mrc-${g}-e`, '');
  });
  // Radios
  document.querySelectorAll('input[name="sv"]').forEach(r => r.checked = false);
  // Medicações outras
  document.getElementById('f-med-outras').innerHTML = '';
}

async function _herdarMedicacoes(leito){
  // Procura evoluções anteriores deste leito no mesmo dia (outros turnos)
  // ou do dia anterior
  const turnos = ['MANHA','TARDE','NOITE'];
  const hj = hoje();
  // Tenta outros turnos de hoje
  for (const t of turnos) {
    if (t === turno) continue;
    const ev = await dbGet(evKey(leito, t, hj));
    if (ev && ev.med) {
      _aplicarMedicacoes(ev.med);
      return;
    }
  }
  // Tenta turno anterior (dia anterior)
  const ontem = new Date();
  ontem.setDate(ontem.getDate() - 1);
  const ontemStr = ontem.getFullYear() + '-' + pad(ontem.getMonth()+1) + '-' + pad(ontem.getDate());
  for (const t of turnos) {
    const ev = await dbGet(evKey(leito, t, ontemStr));
    if (ev && ev.med) {
      _aplicarMedicacoes(ev.med);
      return;
    }
  }
}

function _aplicarMedicacoes(med){
  setF('f-med-nora', med.nora || '');
  setF('f-med-dobu', med.dobu || '');
  setF('f-med-fent', med.fent || '');
  setF('f-med-mida', med.mida || '');
  setF('f-med-prec', med.prec || '');
  document.getElementById('f-med-outras').innerHTML = '';
  (med.outras || []).forEach(o => _addLinhaMed(o.nome, o.dose));
}

function addMedicacao(){ _addLinhaMed('', ''); }

function _addLinhaMed(nome, dose){
  const cont = document.getElementById('f-med-outras');
  const row = document.createElement('div');
  row.className = 'med-row-outra';
  row.innerHTML = `
    <input type="text" placeholder="Nome" value="${esc(nome||'')}">
    <input type="number" step="0.1" placeholder="ml/h" value="${dose||''}">
    <span style="font-size:.7rem;color:var(--muted);">ml/h</span>
    <button class="rm" onclick="this.parentElement.remove()" title="Remover">×</button>
  `;
  cont.appendChild(row);
  _ativarCaixaAltaEm(row);
}

function toggleVMI(){
  const sel = document.querySelector('input[name="sv"]:checked');
  const box = document.getElementById('vmi-box');
  if (sel && sel.value === 'VMI') {
    box.classList.add('ativo');
  } else {
    box.classList.remove('ativo');
  }
}

// Caixa alta automática em text/textarea (padrão do sistema)
function _ativarCaixaAlta(){
  document.querySelectorAll('#t-form input[type="text"], #t-form textarea').forEach(el => {
    if (el.dataset.ca === '1') return;
    el.dataset.ca = '1';
    el.addEventListener('input', () => {
      const pos = el.selectionStart;
      const up = el.value.toUpperCase();
      if (el.value !== up) { el.value = up; el.setSelectionRange(pos, pos); }
    });
  });
}
function _ativarCaixaAltaEm(container){
  container.querySelectorAll('input[type="text"], textarea').forEach(el => {
    if (el.dataset.ca === '1') return;
    el.dataset.ca = '1';
    el.addEventListener('input', () => {
      const pos = el.selectionStart;
      const up = el.value.toUpperCase();
      if (el.value !== up) { el.value = up; el.setSelectionRange(pos, pos); }
    });
  });
}

// ── COLETA DE DADOS ──────────────────────────────────────────────────────────
function _coletarDados(){
  const svSel = document.querySelector('input[name="sv"]:checked');
  const aspiracoes = [];
  document.querySelectorAll('#asp-cg input[type="checkbox"]').forEach(cb => {
    if (cb.checked) {
      const label = cb.parentElement.textContent.trim();
      aspiracoes.push(label);
    }
  });
  const outras = [];
  document.querySelectorAll('#f-med-outras .med-row-outra').forEach(row => {
    const nome = row.querySelector('input[type="text"]').value.trim();
    const dose = row.querySelector('input[type="number"]').value;
    if (nome) outras.push({ nome, dose });
  });

  return {
    leito: leitoAtual,
    turno,
    data: gf('f-data'),
    pac: gf('f-pac'),
    sexo: gf('f-sexo'),
    idade: gf('f-idade'),
    diag: gf('f-diag'),
    dtot: gf('f-dtot'),
    dtqt: gf('f-dtqt'),
    extb: gf('f-extb'),
    reiot: gf('f-reiot'),
    hfa: gf('f-hfa'),
    med: {
      nora: gf('f-med-nora'),
      dobu: gf('f-med-dobu'),
      fent: gf('f-med-fent'),
      mida: gf('f-med-mida'),
      prec: gf('f-med-prec'),
      outras
    },
    ap: gf('f-ap'),
    gl: gf('f-gl'),
    ect: gf('f-ect'),
    mrc: gf('f-mrc'),
    jh: gf('f-jh'),
    sv: svSel ? svSel.value : '',
    svExtra: {
      cnLmin:  gf('f-cn-lmin'),
      mvFio2:  gf('f-mv-fio2'),
      mnrLmin: gf('f-mnr-lmin')
    },
    ssvv: {
      fc: gf('f-fc'), fr: gf('f-fr'), pa: gf('f-pa'),
      spo2: gf('f-spo2'), temp: gf('f-temp')
    },
    vmi: {
      modo: gf('f-vmodo'), vt: gf('f-vt'), cest: gf('f-cest'),
      pcps: gf('f-pcps'), fr: gf('f-vfr'), raw: gf('f-raw'),
      peep: gf('f-peep'), vm: gf('f-vm'), ppt: gf('f-ppt'),
      fio2: gf('f-fio2'), tins: gf('f-tins'), dp: gf('f-dp'),
      fluxo: gf('f-fluxo'), ie: gf('f-ie'), apeep: gf('f-apeep')
    },
    mrcTab: {
      ombro: { d: gf('f-mrc-ombro-d'), e: gf('f-mrc-ombro-e') },
      cotov: { d: gf('f-mrc-cotov-d'), e: gf('f-mrc-cotov-e') },
      punho: { d: gf('f-mrc-punho-d'), e: gf('f-mrc-punho-e') },
      quad:  { d: gf('f-mrc-quad-d'),  e: gf('f-mrc-quad-e') },
      joel:  { d: gf('f-mrc-joel-d'),  e: gf('f-mrc-joel-e') },
      dors:  { d: gf('f-mrc-dors-d'),  e: gf('f-mrc-dors-e') }
    },
    aspiracoes,
    cr: gf('f-cr'),
    cm: gf('f-cm'),
    obs: gf('f-obs'),
    autor: usuarioEmail,
    criadoEm: new Date().toISOString()
  };
}

function _carregarDadosForm(d){
  setF('f-data', d.data || hoje());
  setF('f-idade', d.idade);
  setF('f-diag', d.diag);
  setF('f-dtot', d.dtot); setF('f-dtqt', d.dtqt);
  setF('f-extb', d.extb); setF('f-reiot', d.reiot);
  setF('f-hfa', d.hfa);
  if (d.med) {
    setF('f-med-nora', d.med.nora); setF('f-med-dobu', d.med.dobu);
    setF('f-med-fent', d.med.fent); setF('f-med-mida', d.med.mida);
    setF('f-med-prec', d.med.prec);
    document.getElementById('f-med-outras').innerHTML = '';
    (d.med.outras||[]).forEach(o => _addLinhaMed(o.nome, o.dose));
  }
  setF('f-ap', d.ap); setF('f-gl', d.gl); setF('f-ect', d.ect);
  setF('f-mrc', d.mrc); setF('f-jh', d.jh);
  if (d.sv) {
    const r = document.querySelector(`input[name="sv"][value="${d.sv}"]`);
    if (r) r.checked = true;
  }
  if (d.svExtra) {
    setF('f-cn-lmin', d.svExtra.cnLmin);
    setF('f-mv-fio2', d.svExtra.mvFio2);
    setF('f-mnr-lmin', d.svExtra.mnrLmin);
  }
  if (d.ssvv) {
    setF('f-fc', d.ssvv.fc); setF('f-fr', d.ssvv.fr);
    setF('f-pa', d.ssvv.pa); setF('f-spo2', d.ssvv.spo2);
    setF('f-temp', d.ssvv.temp);
  }
  if (d.vmi) {
    setF('f-vmodo', d.vmi.modo); setF('f-vt', d.vmi.vt); setF('f-cest', d.vmi.cest);
    setF('f-pcps', d.vmi.pcps); setF('f-vfr', d.vmi.fr); setF('f-raw', d.vmi.raw);
    setF('f-peep', d.vmi.peep); setF('f-vm', d.vmi.vm); setF('f-ppt', d.vmi.ppt);
    setF('f-fio2', d.vmi.fio2); setF('f-tins', d.vmi.tins); setF('f-dp', d.vmi.dp);
    setF('f-fluxo', d.vmi.fluxo); setF('f-ie', d.vmi.ie); setF('f-apeep', d.vmi.apeep);
  }
  if (d.mrcTab) {
    ['ombro','cotov','punho','quad','joel','dors'].forEach(g => {
      if (d.mrcTab[g]) {
        setF(`f-mrc-${g}-d`, d.mrcTab[g].d);
        setF(`f-mrc-${g}-e`, d.mrcTab[g].e);
      }
    });
  }
  // Aspirações (marca checkboxes pelos textos)
  setTimeout(() => {
    (d.aspiracoes||[]).forEach(asp => {
      document.querySelectorAll('#asp-cg .asp-c').forEach(l => {
        if (l.textContent.trim() === asp) {
          const cb = l.querySelector('input');
          cb.checked = true;
          l.classList.add('marcado');
        }
      });
    });
  }, 50);
  setF('f-cr', d.cr); setF('f-cm', d.cm); setF('f-obs', d.obs);
}

// ── GERAR PREVIEW ────────────────────────────────────────────────────────────
async function gerarPreview(){
  const dados = _coletarDados();
  if (!dados.pac) { toast('Paciente não identificado', true); return; }

  // Salva no Firestore antes de mostrar preview
  showLoading('Salvando...');
  try {
    await dbSet(evKey(leitoAtual, turno, hoje()), dados);
  } catch(e) {
    console.error('Erro ao salvar:', e);
    toast('Erro ao salvar — verifique a conexão', true);
  } finally {
    hideLoading();
  }

  renderPreview(dados);
  const b = document.getElementById('badge-prev');
  const mapa = { MANHA:'🌅 MANHÃ', TARDE:'☀ TARDE', NOITE:'🌙 NOITE' };
  b.textContent = mapa[turno] || turno;
  b.className = 'badge ' + (turno === 'NOITE' ? 'badge-n' : 'badge-d');
  document.getElementById('prev-sub').textContent = `Leito ${pad(leitoAtual)} · ${_labelTurno(turno)} · ${fmtD(hoje())}`;
  irPreview();
}

function renderPreview(d){
  const area = document.getElementById('preview-area');
  const ssvv = d.ssvv || {};
  const vmi  = d.vmi  || {};
  const med  = d.med  || {};
  const mrcTab = d.mrcTab || {};
  const svExtra = d.svExtra || {};

  // Monta texto da ventilação (AA, CN 3 L/min, VMI, etc.)
  let svText = d.sv || '—';
  if (d.sv === 'CN' && svExtra.cnLmin) svText = `CN ${svExtra.cnLmin} L/min`;
  else if (d.sv === 'MV' && svExtra.mvFio2) svText = `MV ${svExtra.mvFio2}%`;
  else if (d.sv === 'Mascara NR' && svExtra.mnrLmin) svText = `Máscara NR ${svExtra.mnrLmin} L/min`;
  else if (d.sv === 'Mascara NR') svText = 'Máscara não-reinalante';

  const medList = [];
  if (med.nora) medList.push(`Noradrenalina ${med.nora} ml/h`);
  if (med.dobu) medList.push(`Dobutamina ${med.dobu} ml/h`);
  if (med.fent) medList.push(`Fentanil ${med.fent} ml/h`);
  if (med.mida) medList.push(`Midazolam ${med.mida} ml/h`);
  if (med.prec) medList.push(`Precedex ${med.prec} ml/h`);
  (med.outras||[]).forEach(o => {
    if (o.nome) medList.push(`${o.nome}${o.dose ? ' ' + o.dose + ' ml/h' : ''}`);
  });

  const mrcRow = (label, k) => `<tr><td>${label}</td>
    <td>${esc((mrcTab[k]||{}).d)||'—'}</td>
    <td>${esc((mrcTab[k]||{}).e)||'—'}</td></tr>`;

  area.innerHTML = `
    <div class="pv-h">
      <div class="logo">🏃</div>
      <h1>HOSPITAL DOS PESCADORES<br>FICHA DE EVOLUÇÃO FISIOTERAPIA – UTI</h1>
      <div class="logo" style="text-align:right;">HOSPESC</div>
    </div>

    <div class="pv-id">
      <div class="pv-row">
        <span><strong>Turno:</strong> ${_labelTurno(d.turno)}</span>
        <span><strong>Data:</strong> ${fmtD(d.data)}</span>
        <span><strong>Leito:</strong> ${pad(d.leito)}</span>
      </div>
      <div class="pv-row" style="margin-top:3px;">
        <span><strong>Nome:</strong> ${esc(d.pac)}</span>
        <span><strong>Sexo:</strong> ${esc(d.sexo)||'—'}</span>
        <span><strong>Idade:</strong> ${esc(d.idade)||'—'}</span>
      </div>
      <div class="pv-row" style="margin-top:3px;">
        <span><strong>Diagnóstico:</strong> ${esc(d.diag)||'—'}</span>
      </div>
      <div class="pv-row" style="margin-top:3px;">
        ${d.dtot ? `<span><strong>Dias TOT:</strong> ${esc(d.dtot)}</span>` : ''}
        ${d.dtqt ? `<span><strong>Dias TQT:</strong> ${esc(d.dtqt)}</span>` : ''}
        ${d.extb ? `<span><strong>EXTB:</strong> ${fmtD(d.extb)}</span>` : ''}
        ${d.reiot ? `<span><strong>RE-IOT:</strong> ${fmtD(d.reiot)}</span>` : ''}
      </div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Estado Geral (HFA)</div>
      <div class="pv-sec-c pv-textao">${esc(d.hfa)||'—'}</div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Medicações em Infusão</div>
      <div class="pv-sec-c">${medList.length ? medList.join(' · ') : '—'}</div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Avaliação Clínica</div>
      <div class="pv-sec-c">
        <div><strong>AP:</strong> ${esc(d.ap)||'—'}</div>
        <div class="pv-row" style="margin-top:3px;">
          <span><strong>Glasgow/Ramsay:</strong> ${esc(d.gl)||'—'}</span>
          <span><strong>Ectoscopia resp.:</strong> ${esc(d.ect)||'—'}</span>
          <span><strong>Total MRC:</strong> ${esc(d.mrc)||'—'}</span>
          ${d.jh ? `<span><strong>Johns Hopkins:</strong> ${esc(d.jh)}</span>` : ''}
        </div>
      </div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Suporte Ventilatório / SSVV</div>
      <div class="pv-sec-c">
        <div><strong>Suporte:</strong> ${esc(svText)}</div>
        <div class="pv-row" style="margin-top:3px;">
          <span><strong>FC:</strong> ${esc(ssvv.fc)||'—'} bpm</span>
          <span><strong>FR:</strong> ${esc(ssvv.fr)||'—'} mrm</span>
          <span><strong>PA:</strong> ${esc(ssvv.pa)||'—'} mmHg</span>
          <span><strong>SpO₂:</strong> ${esc(ssvv.spo2)||'—'} %</span>
          <span><strong>Temp:</strong> ${esc(ssvv.temp)||'—'} °C</span>
        </div>
      </div>
    </div>

    ${d.sv === 'VMI' ? `
    <div class="pv-sec">
      <div class="pv-sec-t">Parâmetros Ventilatórios (VMI)</div>
      <div class="pv-sec-c">
        <div class="pv-row">
          <span><strong>Modo:</strong> ${esc(vmi.modo)||'—'}</span>
          <span><strong>Vt:</strong> ${esc(vmi.vt)||'—'}</span>
          <span><strong>Cest:</strong> ${esc(vmi.cest)||'—'}</span>
          <span><strong>PC/PS:</strong> ${esc(vmi.pcps)||'—'}</span>
          <span><strong>FR:</strong> ${esc(vmi.fr)||'—'}</span>
          <span><strong>Raw:</strong> ${esc(vmi.raw)||'—'}</span>
        </div>
        <div class="pv-row" style="margin-top:3px;">
          <span><strong>PEEP:</strong> ${esc(vmi.peep)||'—'}</span>
          <span><strong>VM:</strong> ${esc(vmi.vm)||'—'}</span>
          <span><strong>Ppt:</strong> ${esc(vmi.ppt)||'—'}</span>
          <span><strong>FiO₂:</strong> ${esc(vmi.fio2)||'—'} %</span>
          <span><strong>Tins:</strong> ${esc(vmi.tins)||'—'}</span>
          <span><strong>DP:</strong> ${esc(vmi.dp)||'—'}</span>
        </div>
        <div class="pv-row" style="margin-top:3px;">
          <span><strong>Fluxo:</strong> ${esc(vmi.fluxo)||'—'}</span>
          <span><strong>I:E:</strong> ${esc(vmi.ie)||'—'}</span>
          <span><strong>Auto-PEEP:</strong> ${esc(vmi.apeep)||'—'}</span>
        </div>
      </div>
    </div>` : ''}

    <div class="pv-sec">
      <div class="pv-sec-t">MRC – Bilateral</div>
      <div class="pv-sec-c">
        <table class="pv-tabela">
          <thead><tr><th></th><th>Direito</th><th>Esquerdo</th></tr></thead>
          <tbody>
            ${mrcRow('Abdução de ombro', 'ombro')}
            ${mrcRow('Flexão de cotovelo', 'cotov')}
            ${mrcRow('Extensão de punho', 'punho')}
            ${mrcRow('Flexão de quadril', 'quad')}
            ${mrcRow('Extensão de joelho', 'joel')}
            ${mrcRow('Dorsiflexão', 'dors')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Aspiração – Horários</div>
      <div class="pv-sec-c">${(d.aspiracoes||[]).length ? (d.aspiracoes||[]).join(' · ') : '—'}</div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Conduta Respiratória</div>
      <div class="pv-sec-c pv-textao">${esc(d.cr)||'—'}</div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Conduta Motora</div>
      <div class="pv-sec-c pv-textao">${esc(d.cm)||'—'}</div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Observações</div>
      <div class="pv-sec-c pv-textao">${esc(d.obs)||'—'}</div>
    </div>

    <div class="pv-foot">
      Fisioterapeuta: ${esc(d.autor)||'—'} · ${new Date().toLocaleString('pt-BR')}
    </div>
  `;
}

// ── GERAR PDF E ENVIAR AO DRIVE ──────────────────────────────────────────────
async function gerarPDF(){
  const btn = document.getElementById('btn-pdf');
  const status = document.getElementById('pdf-status');
  const area = document.getElementById('preview-area');
  const wrap = document.getElementById('preview-wrap');
  if (!area.innerHTML.trim()) { alert('Gere a impressão primeiro.'); return; }

  btn.disabled = true; btn.textContent = '⏳ Gerando...';
  status.textContent = 'Capturando...'; status.style.color = 'var(--muted)';

  const origW = area.style.width, origMW = area.style.maxWidth;
  const origWW = wrap.style.width, origWMW = wrap.style.maxWidth;
  const origBody = document.body.style.overflow;
  const LARGURA_FIXA = 780;
  area.style.width = LARGURA_FIXA + 'px'; area.style.maxWidth = 'none';
  wrap.style.width = LARGURA_FIXA + 'px'; wrap.style.maxWidth = 'none';
  document.body.style.overflow = 'hidden';

  try {
    const {jsPDF} = window.jspdf;
    const pdf = new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const contentW = pageW - margin*2;
    const contentH = pageH - margin*2;

    const canvas = await html2canvas(area, {
      scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false,
      width: LARGURA_FIXA, windowWidth: LARGURA_FIXA
    });

    const mmTotal = (canvas.height / canvas.width) * contentW;
    let larguraUso = contentW;
    const PAGINAS_ALVO = 2;
    if (mmTotal > PAGINAS_ALVO * contentH) {
      const fator = (PAGINAS_ALVO * contentH) / mmTotal;
      larguraUso = contentW * fator;
    }
    const pxPorPagina = Math.floor((contentH / contentW) * canvas.width * (contentW / larguraUso));
    const offsetX = margin + (contentW - larguraUso) / 2;

    function addFatia(yStart, yEnd){
      const h = yEnd - yStart;
      const sc = document.createElement('canvas');
      sc.width = canvas.width; sc.height = h;
      const ctx = sc.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,sc.width,h);
      ctx.drawImage(canvas, 0,yStart, canvas.width,h, 0,0, canvas.width,h);
      const mmH = (h / canvas.width) * larguraUso;
      pdf.addImage(sc.toDataURL('image/jpeg', .92), 'JPEG', offsetX, margin, larguraUso, mmH);
    }

    if (canvas.height <= pxPorPagina) {
      addFatia(0, canvas.height);
    } else {
      let yStart = 0, pag = 0;
      while (yStart < canvas.height && pag < PAGINAS_ALVO) {
        if (pag > 0) pdf.addPage();
        const yEnd = Math.min(yStart + pxPorPagina, canvas.height);
        addFatia(yStart, yEnd);
        yStart = yEnd; pag++;
      }
    }

    // Nome do arquivo e pasta
    const d = _coletarDados();
    const [ano, mes, dia] = (d.data||hoje()).split('-');
    const dataBR = dia + mes + ano;
    const nomePac = (d.pac || '').trim();
    const primNome = (nomePac.split(' ')[0] || 'Pac').toUpperCase();
    const pastaNome = nomePac
      ? `Leito ${pad(leitoAtual)} - ${nomePac}`
      : `Leito ${pad(leitoAtual)} - Sem identificacao`;
    const titulo = `EvolucaoFisio_L${pad(leitoAtual)}_${turno}_${dataBR}_${primNome}`;

    status.textContent = 'Enviando ao Drive...';
    const dataUri = pdf.output('datauristring');
    const base64  = dataUri.split(',')[1];

    await fetch(APPS_SCRIPT_URL, {
      method:  'POST',
      mode:    'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify({
        titulo,
        arquivoBase64: base64,
        pasta: pastaNome,
        pastaRaizId: PASTA_EVOLUCAO_ID
      })
    });

    status.textContent = '✓ Enviado ao Drive com sucesso';
    status.style.color = 'var(--verde)';
    toast('✓ PDF salvo no Drive');

  } catch(err) {
    console.error('gerarPDF:', err);
    status.textContent = 'Erro ao gerar/enviar. Tente novamente ou use Ctrl+P.';
    status.style.color = 'var(--vermelho)';
  } finally {
    area.style.width = origW; area.style.maxWidth = origMW;
    wrap.style.width = origWW; wrap.style.maxWidth = origWMW;
    document.body.style.overflow = origBody;
  }

  btn.disabled = false; btn.textContent = '☁ Salvar PDF no Drive';
}

// ── INICIALIZAÇÃO ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  mostrarTela('t-login');
  document.getElementById('t-login').classList.add('ativa');

  if (!auth) {
    // Modo offline
    modoOffline = true;
    return;
  }

  auth.onAuthStateChanged(user => {
    if (user) {
      usuarioEmail = user.email;
      irTelaTurno();
    } else {
      mostrarTela('t-login');
    }
  });
});
