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
const memCache = {}; // cache em memória para leituras paralelas

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
  if (memCache[key] !== undefined) return memCache[key];
  if (!modoOffline && db) {
    try {
      const doc = await db.collection('uti').doc(key).get();
      if (doc.exists) {
        const data = doc.data();
        // Aceita tanto "value" (enfermagem) quanto "v" (caso alguma rodada antiga tenha gravado)
        const valor = data.value !== undefined ? data.value : data.v;
        if (valor !== undefined) {
          memCache[key] = valor;
          localStorage.setItem(key, JSON.stringify(valor));
          return valor;
        }
      }
    } catch(e) { console.warn('dbGet firestore:', e); }
  }
  const cached = localStorage.getItem(key);
  if (cached) try {
    const v = JSON.parse(cached);
    memCache[key] = v;
    return v;
  } catch(e){}
  return null;
}
async function dbGetMany(keys){
  // Leitura paralela com Promise.all; usa cache em memória quando disponível
  const results = await Promise.all(keys.map(k => dbGet(k)));
  return Object.fromEntries(keys.map((k, i) => [k, results[i]]));
}
async function dbSet(key, value){
  memCache[key] = value;
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
  const mapa = { DIURNO:'☀ DIURNO', NOTURNO:'🌙 NOTURNO' };
  b.textContent = mapa[t] || t;
  b.className = 'badge ' + (t === 'NOTURNO' ? 'badge-n' : 'badge-d');
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

  // Monta lista de chaves de evolução dos leitos ocupados para leitura paralela
  const hojeStr = hoje();
  const chaves = [];
  for (let i = 1; i <= TOTAL; i++) {
    const l = d[i] || { ocupado: false };
    if (l.ocupado) chaves.push(evKey(i, turno, hojeStr));
  }
  const evMap = chaves.length ? await dbGetMany(chaves) : {};

  for (let i = 1; i <= TOTAL; i++) {
    const l = d[i] || { ocupado:false };
    const ev = l.ocupado ? evMap[evKey(i, turno, hojeStr)] : null;

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
  abrirAcomp(leitoAtual);
}

// ══════════════════════════════════════════════════════════════════════════════
// ACOMPANHAMENTO DIÁRIO — ficha cumulativa por internação
// ══════════════════════════════════════════════════════════════════════════════

// Estado em memória do acompanhamento sendo editado
let acompAtual = null;     // {leito, pac, ...campos, colunas:[], eventos:[]}
let acompEditandoIdx = -1; // índice da coluna sendo editada (-1 = nova)

// Chave: fisio_acomp_<leito>_<adm>. Usa a data de admissão para garantir um
// documento único por internação (se o paciente tem alta e volta, vira novo).
function acompKey(leito, adm){
  const advalid = adm || 'sem-adm';
  return `fisio_acomp_${leito}_${advalid}`;
}

async function abrirAcomp(leito){
  leitoAtual = leito;
  showLoading('Carregando acompanhamento...');
  const d = await leitosData();
  const l = d[leito];
  const adm = l.adm || '';

  // Carrega documento existente ou inicializa um novo
  let doc = await dbGet(acompKey(leito, adm));
  if (!doc) {
    // Calcula idade
    let idade = '';
    if (l.dn) {
      const [y,m,dd] = l.dn.split('-').map(Number);
      const dn = new Date(y, m-1, dd);
      const hj = new Date();
      idade = hj.getFullYear() - dn.getFullYear();
      if (hj.getMonth() < dn.getMonth() || (hj.getMonth() === dn.getMonth() && hj.getDate() < dn.getDate())) idade--;
    }
    doc = {
      leito,
      pac: l.pac || '',
      diag: l.diag || '',
      adm: adm,
      idade: String(idade || ''),
      altura: '',
      peso: '',
      vt4: '', vt6: '', vt8: '',
      colunas: [],
      eventos: [],
      criadoEm: new Date().toISOString()
    };
  }
  acompAtual = doc;
  acompEditandoIdx = -1;

  // Preenche header/cabeçalho
  setF('a-pac', doc.pac);
  setF('a-leito', pad(leito));
  setF('a-idade', doc.idade);
  setF('a-adm', doc.adm);
  setF('a-diag', doc.diag);
  setF('a-altura', doc.altura);
  setF('a-peso', doc.peso);
  setF('a-vt4', doc.vt4);
  setF('a-vt6', doc.vt6);
  setF('a-vt8', doc.vt8);

  // Preenche formulário de nova coluna com data/turno/hora atuais
  _limparFormColuna();
  setF('ac-data', hoje());
  setF('ac-turno', turno);
  const agora = new Date();
  setF('ac-hora', pad(agora.getHours()) + ':' + pad(agora.getMinutes()));
  setF('ac-prof', (usuarioEmail||'').split('@')[0]);

  // Se já existe uma coluna para este turno/hoje, carrega em modo edição
  const idxExistente = doc.colunas.findIndex(c => c.data === hoje() && c.turno === turno);
  if (idxExistente >= 0) {
    _carregarFormColuna(doc.colunas[idxExistente], idxExistente);
    toast('Coluna deste turno já existe — editando');
  }

  _renderTabelaAcomp();
  _renderEventosAcomp();

  // Atualiza header
  document.getElementById('acomp-sub').textContent = `Leito ${pad(leito)} · ${doc.pac} · adm ${fmtD(doc.adm)||'—'}`;
  const b = document.getElementById('badge-acomp');
  const mapa = { DIURNO:'☀ DIURNO', NOTURNO:'🌙 NOTURNO' };
  b.textContent = mapa[turno] || turno;
  b.className = 'badge ' + (turno === 'NOTURNO' ? 'badge-n' : 'badge-d');

  _ativarCaixaAltaEm(document.getElementById('t-acomp'));
  hideLoading();
  mostrarTela('t-acomp');
  window.scrollTo(0,0);
}

function _limparFormColuna(){
  const ids = ['ac-data','ac-turno','ac-hora','ac-oxig','ac-vni','ac-tvni',
    'ac-dtot','ac-modo','ac-fio2','ac-pcps','ac-peep','ac-vc','ac-vm','ac-tre',
    'ac-ph','ac-paco2','ac-pao2','ac-hco3','ac-be','ac-relacao',
    'ac-cuff','ac-inc','ac-hmef','ac-qsec','ac-asec',
    'ac-leuc','ac-hbht','ac-plaq','ac-urcr','ac-pcr','ac-jh','ac-prof'];
  ids.forEach(id => setF(id, ''));
  acompEditandoIdx = -1;
  document.getElementById('btn-cancelar-edicao').style.display = 'none';
  document.getElementById('ac-form-t').textContent = '➕ Adicionar coluna do turno atual';
  document.getElementById('btn-salvar-coluna').textContent = '💾 Salvar coluna';
}

function _carregarFormColuna(col, idx){
  setF('ac-data', col.data); setF('ac-turno', col.turno); setF('ac-hora', col.hora);
  setF('ac-oxig', col.oxig); setF('ac-vni', col.vni); setF('ac-tvni', col.tvni);
  setF('ac-dtot', col.dtot); setF('ac-modo', col.modo); setF('ac-fio2', col.fio2);
  setF('ac-pcps', col.pcps); setF('ac-peep', col.peep);
  setF('ac-vc', col.vc); setF('ac-vm', col.vm); setF('ac-tre', col.tre);
  setF('ac-ph', col.ph); setF('ac-paco2', col.paco2); setF('ac-pao2', col.pao2);
  setF('ac-hco3', col.hco3); setF('ac-be', col.be); setF('ac-relacao', col.relacao);
  setF('ac-cuff', col.cuff); setF('ac-inc', col.inc); setF('ac-hmef', col.hmef);
  setF('ac-qsec', col.qsec); setF('ac-asec', col.asec);
  setF('ac-leuc', col.leuc); setF('ac-hbht', col.hbht); setF('ac-plaq', col.plaq);
  setF('ac-urcr', col.urcr); setF('ac-pcr', col.pcr); setF('ac-jh', col.jh);
  setF('ac-prof', col.prof);
  acompEditandoIdx = idx;
  document.getElementById('btn-cancelar-edicao').style.display = '';
  document.getElementById('ac-form-t').textContent = `✏️ Editando coluna: ${fmtD(col.data)} ${_labelTurno(col.turno)}`;
  document.getElementById('btn-salvar-coluna').textContent = '💾 Salvar alterações';
}

function editarColunaAcomp(idx){
  if (!acompAtual || !acompAtual.colunas[idx]) return;
  _carregarFormColuna(acompAtual.colunas[idx], idx);
  document.getElementById('ac-form-t').scrollIntoView({behavior:'smooth', block:'start'});
}

function cancelarEdicaoColuna(){
  _limparFormColuna();
  setF('ac-data', hoje());
  setF('ac-turno', turno);
  const agora = new Date();
  setF('ac-hora', pad(agora.getHours()) + ':' + pad(agora.getMinutes()));
  setF('ac-prof', (usuarioEmail||'').split('@')[0]);
}

function _coletarColuna(){
  return {
    data:   gf('ac-data'),
    turno:  gf('ac-turno'),
    hora:   gf('ac-hora'),
    oxig:   gf('ac-oxig'),
    vni:    gf('ac-vni'),
    tvni:   gf('ac-tvni'),
    dtot:   gf('ac-dtot'),
    modo:   gf('ac-modo'),
    fio2:   gf('ac-fio2'),
    pcps:   gf('ac-pcps'),
    peep:   gf('ac-peep'),
    vc:     gf('ac-vc'),
    vm:     gf('ac-vm'),
    tre:    gf('ac-tre'),
    ph:     gf('ac-ph'),
    paco2:  gf('ac-paco2'),
    pao2:   gf('ac-pao2'),
    hco3:   gf('ac-hco3'),
    be:     gf('ac-be'),
    relacao:gf('ac-relacao'),
    cuff:   gf('ac-cuff'),
    inc:    gf('ac-inc'),
    hmef:   gf('ac-hmef'),
    qsec:   gf('ac-qsec'),
    asec:   gf('ac-asec'),
    leuc:   gf('ac-leuc'),
    hbht:   gf('ac-hbht'),
    plaq:   gf('ac-plaq'),
    urcr:   gf('ac-urcr'),
    pcr:    gf('ac-pcr'),
    jh:     gf('ac-jh'),
    prof:   gf('ac-prof'),
    autor:  usuarioEmail,
    atualizadoEm: new Date().toISOString()
  };
}

async function salvarColunaAcomp(){
  if (!acompAtual) return;
  const col = _coletarColuna();
  if (!col.data || !col.turno) { toast('Preencha data e turno', true); return; }

  if (acompEditandoIdx >= 0) {
    // Edição
    acompAtual.colunas[acompEditandoIdx] = col;
    toast('✓ Coluna atualizada');
  } else {
    // Nova — mas verifica duplicata (data + turno)
    const dup = acompAtual.colunas.findIndex(c => c.data === col.data && c.turno === col.turno);
    if (dup >= 0) {
      if (!confirm(`Já existe uma coluna para ${fmtD(col.data)} ${_labelTurno(col.turno)}. Substituir?`)) return;
      acompAtual.colunas[dup] = col;
      toast('✓ Coluna substituída');
    } else {
      acompAtual.colunas.push(col);
      toast('✓ Coluna adicionada');
    }
  }
  // Ordena por data + turno (DIURNO → NOTURNO)
  const ordem = { DIURNO:1, NOTURNO:2 };
  acompAtual.colunas.sort((a,b) => {
    if (a.data !== b.data) return a.data.localeCompare(b.data);
    return (ordem[a.turno]||9) - (ordem[b.turno]||9);
  });
  acompAtual.atualizadoEm = new Date().toISOString();
  await dbSet(acompKey(acompAtual.leito, acompAtual.adm), acompAtual);
  _renderTabelaAcomp();
  cancelarEdicaoColuna();
}

async function salvarCabecalhoAcomp(){
  if (!acompAtual) return;
  acompAtual.idade  = gf('a-idade');
  acompAtual.altura = gf('a-altura');
  acompAtual.peso   = gf('a-peso');
  acompAtual.vt4    = gf('a-vt4');
  acompAtual.vt6    = gf('a-vt6');
  acompAtual.vt8    = gf('a-vt8');
  acompAtual.atualizadoEm = new Date().toISOString();
  await dbSet(acompKey(acompAtual.leito, acompAtual.adm), acompAtual);
  toast('✓ Cabeçalho salvo');
}

// Linhas que aparecem na tabela do acompanhamento.
// type: 'grupo' (cabeçalho de seção) ou {label, campo}
const ACOMP_LINHAS = [
  { type:'grupo', label:'Ventilação' },
  { label:'Oxigenoterapia',       campo:'oxig' },
  { label:'VNI (IPAP/CPAP)',      campo:'vni' },
  { label:'Tempo de uso VNI',     campo:'tvni' },
  { label:'Dias TOT/TQT',         campo:'dtot' },
  { label:'Modo ventilatório',    campo:'modo' },
  { label:'FiO₂ (%)',             campo:'fio2' },
  { label:'PC/PSV',               campo:'pcps' },
  { label:'PEEP',                 campo:'peep' },
  { label:'Volume corrente',      campo:'vc' },
  { label:'Volume minuto',        campo:'vm' },
  { label:'TRE',                  campo:'tre' },
  { type:'grupo', label:'Gasometria' },
  { label:'pH',                   campo:'ph' },
  { label:'PaCO₂',                campo:'paco2' },
  { label:'PaO₂',                 campo:'pao2' },
  { label:'HCO₃',                 campo:'hco3' },
  { label:'BE',                   campo:'be' },
  { label:'PaO₂/FiO₂',            campo:'relacao' },
  { type:'grupo', label:'Cuidados' },
  { label:'Pressão cuff (cmH₂O)', campo:'cuff' },
  { label:'Inclinação (°)',       campo:'inc' },
  { label:'Filtro HMEF',          campo:'hmef', fmt:'data' },
  { label:'Quant. secreção',      campo:'qsec' },
  { label:'Aspecto secreção',     campo:'asec' },
  { type:'grupo', label:'Laboratório' },
  { label:'Leucometria',          campo:'leuc' },
  { label:'Hb/Ht',                campo:'hbht' },
  { label:'Plaquetas',            campo:'plaq' },
  { label:'Ureia/Creatinina',     campo:'urcr' },
  { label:'PCR',                  campo:'pcr' },
  { label:'Johns Hopkins',        campo:'jh' },
];

function _renderTabelaAcomp(){
  const wrap = document.getElementById('acomp-tabela-wrap');
  if (!acompAtual || !acompAtual.colunas.length) {
    wrap.innerHTML = '<div class="acomp-vazio">Nenhuma coluna registrada ainda. Adicione a primeira abaixo.</div>';
    return;
  }
  const cols = acompAtual.colunas;
  let h = '<table class="acomp-t"><thead><tr><th class="rotulo">Campo</th>';
  cols.forEach((c, idx) => {
    h += `<th>
      ${fmtD(c.data)}<br>
      <small style="font-weight:400;opacity:.85;">${_labelTurno(c.turno)}${c.hora?' '+c.hora:''}</small>
      <button class="btn-edit-col" onclick="editarColunaAcomp(${idx})" title="Editar">✎</button>
    </th>`;
  });
  h += '</tr></thead><tbody>';
  ACOMP_LINHAS.forEach(ln => {
    if (ln.type === 'grupo') {
      h += `<tr class="grupo"><td colspan="${cols.length+1}">${esc(ln.label)}</td></tr>`;
      return;
    }
    h += `<tr><td class="rotulo">${esc(ln.label)}</td>`;
    cols.forEach(c => {
      let v = c[ln.campo] || '';
      if (ln.fmt === 'data' && v) v = fmtD(v);
      h += `<td>${esc(v)||'—'}</td>`;
    });
    h += '</tr>';
  });
  // Linha final: profissional
  h += `<tr><td class="rotulo">Profissional</td>`;
  cols.forEach(c => { h += `<td>${esc(c.prof)||'—'}</td>`; });
  h += '</tr></tbody></table>';
  wrap.innerHTML = h;
}

// ── EVENTOS LIVRES ───────────────────────────────────────────────────────────
function _renderEventosAcomp(){
  const cont = document.getElementById('acomp-eventos');
  if (!acompAtual || !acompAtual.eventos || !acompAtual.eventos.length) {
    cont.innerHTML = '<div class="acomp-vazio" style="padding:8px;">Nenhum evento registrado.</div>';
    return;
  }
  cont.innerHTML = acompAtual.eventos.map((ev, idx) => `
    <div class="acomp-ev-row">
      <span class="data">${fmtD(ev.data)}</span>
      <span class="texto">${esc(ev.texto)}</span>
      <button class="rm" onclick="removerEventoAcomp(${idx})" title="Remover">×</button>
    </div>
  `).join('');
}

async function adicionarEventoAcomp(){
  if (!acompAtual) return;
  const data  = gf('ac-ev-data') || hoje();
  const texto = gf('ac-ev-texto').trim();
  if (!texto) { toast('Descreva o evento', true); return; }
  if (!acompAtual.eventos) acompAtual.eventos = [];
  acompAtual.eventos.push({
    data, texto, autor: usuarioEmail, criadoEm: new Date().toISOString()
  });
  acompAtual.eventos.sort((a,b) => a.data.localeCompare(b.data));
  acompAtual.atualizadoEm = new Date().toISOString();
  await dbSet(acompKey(acompAtual.leito, acompAtual.adm), acompAtual);
  setF('ac-ev-texto', '');
  _renderEventosAcomp();
  toast('✓ Evento adicionado');
}

async function removerEventoAcomp(idx){
  if (!acompAtual || !acompAtual.eventos) return;
  if (!confirm('Remover este evento?')) return;
  acompAtual.eventos.splice(idx, 1);
  acompAtual.atualizadoEm = new Date().toISOString();
  await dbSet(acompKey(acompAtual.leito, acompAtual.adm), acompAtual);
  _renderEventosAcomp();
}

// ── PDF PAISAGEM DO ACOMPANHAMENTO ───────────────────────────────────────────
async function enviarAcompanhamentoDrive(){
  if (!acompAtual) return;
  if (!acompAtual.colunas.length) {
    toast('Adicione pelo menos uma coluna antes de enviar', true);
    return;
  }
  const status = document.getElementById('acomp-status');
  status.textContent = 'Gerando PDF...'; status.style.color = 'var(--muted)';
  showLoading('Gerando PDF...');

  try {
    const {jsPDF} = window.jspdf;
    // A4 paisagem: 297 × 210 mm
    const pdf = new jsPDF({orientation:'landscape', unit:'mm', format:'a4'});
    const pageW = pdf.internal.pageSize.getWidth();   // 297
    const pageH = pdf.internal.pageSize.getHeight();  // 210
    const margin = 10;
    const contentW = pageW - margin*2; // 277

    // Divide as colunas em páginas de no máximo 8 colunas por página
    const COLS_POR_PAG = 8;
    const total = acompAtual.colunas.length;
    const numPag = Math.max(1, Math.ceil(total / COLS_POR_PAG));

    for (let p = 0; p < numPag; p++) {
      const inicio = p * COLS_POR_PAG;
      const fim = Math.min(inicio + COLS_POR_PAG, total);
      const colsDaPagina = acompAtual.colunas.slice(inicio, fim);

      // Renderiza o HTML da página na área oculta
      const areaPdf = document.getElementById('acomp-pdf-area');
      areaPdf.innerHTML = _renderPaginaPDFAcomp(colsDaPagina, p+1, numPag, p===numPag-1);

      // Aguarda o DOM estabilizar
      await new Promise(r => setTimeout(r, 120));

      const canvas = await html2canvas(areaPdf.firstElementChild, {
        scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false,
        width: 1100, windowWidth: 1100
      });

      // Calcula dimensões para caber na página
      const mmH = (canvas.height / canvas.width) * contentW;
      let larguraUso = contentW, alturaUso = mmH;
      const contentH = pageH - margin*2;
      if (alturaUso > contentH) {
        // Reduz proporcionalmente
        const f = contentH / alturaUso;
        alturaUso = contentH;
        larguraUso = larguraUso * f;
      }
      const offsetX = margin + (contentW - larguraUso) / 2;

      if (p > 0) pdf.addPage();
      pdf.addImage(canvas.toDataURL('image/jpeg', .92), 'JPEG', offsetX, margin, larguraUso, alturaUso);
    }

    // Nome e pasta
    const nomePac = (acompAtual.pac || '').trim();
    const primNome = (nomePac.split(' ')[0] || 'Pac').toUpperCase();
    const hj = hoje();
    const [ano, mes, dia] = hj.split('-');
    const dataBR = dia + mes + ano;
    const pastaNome = nomePac
      ? `Leito ${pad(acompAtual.leito)} - ${nomePac}`
      : `Leito ${pad(acompAtual.leito)} - Sem identificacao`;
    const titulo = `AcompFisio_L${pad(acompAtual.leito)}_${dataBR}_${primNome}`;

    status.textContent = 'Enviando ao Drive...';
    const dataUri = pdf.output('datauristring');
    const base64 = dataUri.split(',')[1];

    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        titulo,
        arquivoBase64: base64,
        pasta: pastaNome,
        pastaRaizId: PASTA_ACOMPANHAMENTO_ID
      })
    });

    status.textContent = '✓ Enviado ao Drive com sucesso';
    status.style.color = 'var(--verde)';
    toast('✓ Acompanhamento salvo no Drive');

  } catch(err) {
    console.error('PDF acomp:', err);
    status.textContent = 'Erro ao gerar/enviar. Tente novamente.';
    status.style.color = 'var(--vermelho)';
    toast('Erro ao enviar PDF', true);
  } finally {
    // Limpa a área oculta
    document.getElementById('acomp-pdf-area').innerHTML = '';
    hideLoading();
  }
}

// Gera o HTML de uma página do PDF do acompanhamento
function _renderPaginaPDFAcomp(cols, pagNum, pagTotal, incluirEventos){
  const cab = acompAtual;
  const colsH = cols.map(c =>
    `<th>${fmtD(c.data)}<br>${_labelTurno(c.turno)}${c.hora?'<br>'+c.hora:''}</th>`
  ).join('');

  let corpo = '';
  ACOMP_LINHAS.forEach(ln => {
    if (ln.type === 'grupo') {
      corpo += `<tr class="grupo"><td colspan="${cols.length+1}">${esc(ln.label)}</td></tr>`;
      return;
    }
    corpo += `<tr><td class="rotulo">${esc(ln.label)}</td>`;
    cols.forEach(c => {
      let v = c[ln.campo] || '';
      if (ln.fmt === 'data' && v) v = fmtD(v);
      corpo += `<td>${esc(v)||'—'}</td>`;
    });
    corpo += '</tr>';
  });
  // Profissional
  corpo += `<tr><td class="rotulo">Profissional</td>`;
  cols.forEach(c => { corpo += `<td>${esc(c.prof)||'—'}</td>`; });
  corpo += '</tr>';

  // Eventos só na última página
  let eventosHtml = '';
  if (incluirEventos && cab.eventos && cab.eventos.length) {
    eventosHtml = `
      <div class="ev">
        <h3>Outros Eventos</h3>
        ${cab.eventos.map(ev =>
          `<div class="ev-li"><strong>${fmtD(ev.data)}:</strong> ${esc(ev.texto)}</div>`
        ).join('')}
      </div>`;
  }

  return `<div class="pdf-acomp-area">
    <div class="ph">
      <div style="font-size:.7rem;font-weight:700;color:var(--roxo);">🏃 HOSPESC</div>
      <h1>HOSPITAL DOS PESCADORES<br>ACOMPANHAMENTO DIÁRIO – FISIOTERAPIA UTI</h1>
      <div style="font-size:.65rem;color:#666;">Pág. ${pagNum}/${pagTotal}</div>
    </div>

    <div class="pid">
      <strong>Nome:</strong> ${esc(cab.pac)||'—'}
       &nbsp;·&nbsp; <strong>Idade:</strong> ${esc(cab.idade)||'—'}
       &nbsp;·&nbsp; <strong>Leito:</strong> ${pad(cab.leito)}
       &nbsp;·&nbsp; <strong>Admissão:</strong> ${fmtD(cab.adm)||'—'}
       ${cab.altura?` &nbsp;·&nbsp; <strong>Altura:</strong> ${esc(cab.altura)} m`:''}
       ${cab.peso?` &nbsp;·&nbsp; <strong>Peso predito:</strong> ${esc(cab.peso)} kg`:''}
      <br><strong>Diagnósticos:</strong> ${esc(cab.diag)||'—'}
      ${(cab.vt4||cab.vt6||cab.vt8) ? `<br><strong>VT alvo:</strong>
        ${cab.vt4?'4ml/kg='+esc(cab.vt4)+' ':''}
        ${cab.vt6?'6ml/kg='+esc(cab.vt6)+' ':''}
        ${cab.vt8?'8ml/kg='+esc(cab.vt8):''}` : ''}
    </div>

    <table>
      <thead>
        <tr>
          <th class="rotulo">Campo</th>
          ${colsH}
        </tr>
      </thead>
      <tbody>${corpo}</tbody>
    </table>

    ${eventosHtml}

    <div class="foot">
      Gerado em ${new Date().toLocaleString('pt-BR')} por ${esc(usuarioEmail)||'—'}
    </div>
  </div>`;
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
  const mapa = { DIURNO:'☀ DIURNO', NOTURNO:'🌙 NOTURNO' };
  b.textContent = mapa[turno] || turno;
  b.className = 'badge ' + (turno === 'NOTURNO' ? 'badge-n' : 'badge-d');

  toggleVMI();
  _ativarCaixaAlta();
  irForm();
}

function _labelTurno(t){
  return { DIURNO:'Diurno', NOTURNO:'Noturno' }[t] || t;
}

function _montarAspiracao(){
  const cont = document.getElementById('asp-cg');
  cont.innerHTML = '';
  let horarios = [];
  if (turno === 'DIURNO') horarios = ['07-09h','09-11h','11-13h','13-15h','15-17h','17-19h'];
  else                     horarios = ['19-21h','21-23h','23-01h','01-03h','03-05h','05-07h'];
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
  // Delega à função genérica abaixo
  await _herdarCamposAnterior(leito);
}

// Busca a evolução ANTERIOR mais recente (outro turno do mesmo dia ou turno
// do dia anterior) e herda os campos que fazem sentido herdar entre turnos.
// NÃO herda: SSVV, condutas, HFA, observações, aspirações, data.
async function _herdarCamposAnterior(leito){
  const turnosOrdem = ['DIURNO','NOTURNO'];
  const hj = hoje();

  // 1) Busca em outro turno de HOJE
  let evAnterior = null;
  for (const t of turnosOrdem) {
    if (t === turno) continue;
    const ev = await dbGet(evKey(leito, t, hj));
    if (ev) { evAnterior = ev; break; }
  }
  // 2) Se não achou, busca em turnos de ONTEM (noturno primeiro = mais recente)
  if (!evAnterior) {
    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    const ontemStr = ontem.getFullYear() + '-' + pad(ontem.getMonth()+1) + '-' + pad(ontem.getDate());
    for (const t of ['NOTURNO','DIURNO']) {
      const ev = await dbGet(evKey(leito, t, ontemStr));
      if (ev) { evAnterior = ev; break; }
    }
  }
  if (!evAnterior) return;

  // ── HERDA: Dias TOT / TQT ─────────────────────────────────────
  if (evAnterior.dtot) setF('f-dtot', evAnterior.dtot);
  if (evAnterior.dtqt) setF('f-dtqt', evAnterior.dtqt);
  if (evAnterior.extb)  setF('f-extb',  evAnterior.extb);
  if (evAnterior.reiot) setF('f-reiot', evAnterior.reiot);

  // ── HERDA: Medicações em infusão ──────────────────────────────
  if (evAnterior.med) _aplicarMedicacoes(evAnterior.med);

  // ── HERDA: Avaliação clínica (AP, Glasgow, Ectoscopia, MRC, JH) ─
  if (evAnterior.ap)  setF('f-ap',  evAnterior.ap);
  if (evAnterior.gl)  setF('f-gl',  evAnterior.gl);
  if (evAnterior.ect) setF('f-ect', evAnterior.ect);
  if (evAnterior.mrc) setF('f-mrc', evAnterior.mrc);
  if (evAnterior.jh)  setF('f-jh',  evAnterior.jh);

  // ── HERDA: Suporte ventilatório (AA/CN/MV/VNI/VMI) ────────────
  if (evAnterior.sv) {
    const r = document.querySelector(`input[name="sv"][value="${evAnterior.sv}"]`);
    if (r) r.checked = true;
    if (evAnterior.svExtra) {
      if (evAnterior.svExtra.cnLmin)  setF('f-cn-lmin',  evAnterior.svExtra.cnLmin);
      if (evAnterior.svExtra.mvFio2)  setF('f-mv-fio2',  evAnterior.svExtra.mvFio2);
      if (evAnterior.svExtra.mnrLmin) setF('f-mnr-lmin', evAnterior.svExtra.mnrLmin);
    }
    toggleVMI();
  }

  // ── HERDA: Parâmetros VMI (se estava em VMI) ──────────────────
  if (evAnterior.vmi) {
    const v = evAnterior.vmi;
    if (v.modo)  setF('f-vmodo', v.modo);
    if (v.vt)    setF('f-vt',    v.vt);
    if (v.cest)  setF('f-cest',  v.cest);
    if (v.pcps)  setF('f-pcps',  v.pcps);
    if (v.fr)    setF('f-vfr',   v.fr);
    if (v.raw)   setF('f-raw',   v.raw);
    if (v.peep)  setF('f-peep',  v.peep);
    if (v.vm)    setF('f-vm',    v.vm);
    if (v.ppt)   setF('f-ppt',   v.ppt);
    if (v.fio2)  setF('f-fio2',  v.fio2);
    if (v.tins)  setF('f-tins',  v.tins);
    if (v.dp)    setF('f-dp',    v.dp);
    if (v.fluxo) setF('f-fluxo', v.fluxo);
    if (v.ie)    setF('f-ie',    v.ie);
    if (v.apeep) setF('f-apeep', v.apeep);
  }

  // ── HERDA: MRC bilateral ──────────────────────────────────────
  if (evAnterior.mrcTab) {
    ['ombro','cotov','punho','quad','joel','dors'].forEach(g => {
      if (evAnterior.mrcTab[g]) {
        if (evAnterior.mrcTab[g].d) setF(`f-mrc-${g}-d`, evAnterior.mrcTab[g].d);
        if (evAnterior.mrcTab[g].e) setF(`f-mrc-${g}-e`, evAnterior.mrcTab[g].e);
      }
    });
  }

  // Aviso discreto de que houve herança
  const fmtOrigem = evAnterior.data === hj
    ? `turno ${_labelTurno(evAnterior.turno).toLowerCase()}`
    : `${fmtD(evAnterior.data)} ${_labelTurno(evAnterior.turno).toLowerCase()}`;
  toast(`↻ Campos herdados do ${fmtOrigem}`);
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
// Usa evento "blur" para não interferir com autocorrect/sugestões mobile.
function _ativarCaixaAlta(){
  document.querySelectorAll('#t-form input[type="text"], #t-form textarea').forEach(el => {
    if (el.dataset.ca === '1') return;
    el.dataset.ca = '1';
    el.addEventListener('blur', () => {
      el.value = el.value.toUpperCase();
    });
  });
}
function _ativarCaixaAltaEm(container){
  container.querySelectorAll('input[type="text"], textarea').forEach(el => {
    if (el.dataset.ca === '1') return;
    el.dataset.ca = '1';
    el.addEventListener('blur', () => {
      el.value = el.value.toUpperCase();
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
  const mapa = { DIURNO:'☀ DIURNO', NOTURNO:'🌙 NOTURNO' };
  b.textContent = mapa[turno] || turno;
  b.className = 'badge ' + (turno === 'NOTURNO' ? 'badge-n' : 'badge-d');
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

// ══════════════════════════════════════════════════════════════════════════════
// INDICADORES DE FISIOTERAPIA
// Mortalidade/permanência: lê uti_admissao_log e uti_alta_log (compartilhado).
// Desmame/extubação/mobilização: lê fisio_ev_* e fisio_acomp_*.
// ══════════════════════════════════════════════════════════════════════════════

let _indCategoriaAtiva = 'permanencia';
let _indCache = null;

function irIndicadores(){
  mostrarTela('t-indicadores');
  document.querySelectorAll('.ind-cat-btn').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.ind-cat-btn').forEach(x => x.classList.remove('ativa'));
      b.classList.add('ativa');
      _indCategoriaAtiva = b.dataset.cat;
      _renderCategoriaInd();
    };
  });
  renderIndicadores();
  window.scrollTo(0,0);
}

function _atualizarPeriodoIndicadores(){
  const sel = gf('ind-periodo');
  document.getElementById('ind-custom').style.display = sel === 'custom' ? 'flex' : 'none';
}

function _indPeriodo(){
  const tipo = gf('ind-periodo');
  const hj = new Date(); hj.setHours(23,59,59,999);
  if (tipo === 'all') return { inicio: new Date(2000,0,1), fim: hj, rotulo: 'Todo o histórico' };
  if (tipo === 'custom') {
    const de = gf('ind-de'), ate = gf('ind-ate');
    if (!de || !ate) return null;
    const [ay,am,ad] = de.split('-').map(Number);
    const [by,bm,bd] = ate.split('-').map(Number);
    return {
      inicio: new Date(ay, am-1, ad, 0,0,0),
      fim:    new Date(by, bm-1, bd, 23,59,59),
      rotulo: `${fmtD(de)} até ${fmtD(ate)}`
    };
  }
  const dias = parseInt(tipo);
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - dias);
  inicio.setHours(0,0,0,0);
  return { inicio, fim: hj, rotulo: `Últimos ${dias} dias` };
}

// Carrega dados brutos: logs da enfermagem + evoluções/acompanhamentos da fisio
async function _carregarDadosInd(){
  showLoading('Carregando indicadores...');
  try {
    const fixas = ['uti_admissao_log','uti_alta_log'];
    const dinamicas = new Set();

    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('fisio_ev_') || k.startsWith('fisio_acomp_'))) dinamicas.add(k);
    }
    if (!modoOffline && db) {
      try {
        const snap = await db.collection('uti').get();
        snap.forEach(doc => {
          if (doc.id.startsWith('fisio_ev_') || doc.id.startsWith('fisio_acomp_')) dinamicas.add(doc.id);
        });
      } catch(e) { console.warn('_carregarDadosInd:', e); }
    }

    const todasChaves = [...fixas, ...Array.from(dinamicas)];
    const dataMap = await dbGetMany(todasChaves);

    const admissoes = dataMap['uti_admissao_log'] || [];
    const altas     = dataMap['uti_alta_log']     || [];
    const evolucoes = [], acompanhamentos = [];
    for (const k of dinamicas) {
      const v = dataMap[k];
      if (!v) continue;
      if (k.startsWith('fisio_ev_'))    evolucoes.push(v);
      if (k.startsWith('fisio_acomp_')) acompanhamentos.push(v);
    }
    _indCache = { admissoes, altas, evolucoes, acompanhamentos };
  } finally {
    hideLoading();
  }
  return _indCache;
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function _dataLocal(s){
  if (!s) return null;
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d, 12, 0, 0);
}
function _diasEntre(a, b){
  if (!a || !b) return null;
  const da = _dataLocal(a), dbt = _dataLocal(b);
  if (!da || !dbt) return null;
  return Math.max(0, Math.round((dbt - da) / 86400000));
}
function _dentroPeriodo(dataStr, periodo){
  if (!dataStr) return false;
  const d = _dataLocal(dataStr);
  if (!d) return false;
  return d >= periodo.inicio && d <= periodo.fim;
}
function _pct(num, den, casas=1){
  if (!den || den === 0) return '0%';
  return (num*100/den).toFixed(casas) + '%';
}

function _cardInd(label, valor, sub='', cls='', fichaId=''){
  const btn = fichaId
    ? `<button class="ind-info-btn" onclick="abrirFichaIndicador('${fichaId}')" title="Sobre este indicador">ℹ️</button>`
    : '';
  return `<div class="ind-card ${cls}">
    ${btn}
    <div class="ind-card-l">${label}</div>
    <div class="ind-card-v">${valor}</div>
    ${sub ? `<div class="ind-card-s">${sub}</div>` : ''}
  </div>`;
}

function _rankingBarras(titulo, itens, max=null, fichaId=''){
  const btn = fichaId
    ? `<button class="ind-info-btn ind-grupo-info" onclick="abrirFichaIndicador('${fichaId}')" title="Sobre este indicador">ℹ️</button>`
    : '';
  if (!itens.length) {
    return `<div class="ind-grupo"><div class="ind-grupo-t">${titulo}</div>${btn}<div class="ind-vazio">Sem dados no período.</div></div>`;
  }
  const top = max ? itens.slice(0, max) : itens;
  const maior = Math.max(...top.map(i => i.valor));
  let h = `<div class="ind-grupo"><div class="ind-grupo-t">${titulo}</div>${btn}<div class="ind-bar-wrap">`;
  top.forEach(i => {
    const pct = maior > 0 ? (i.valor*100/maior) : 0;
    h += `<div class="ind-bar">
      <span class="ind-bar-l" title="${esc(i.label)}">${esc(i.label)}</span>
      <div class="ind-bar-bg"><div class="ind-bar-fill" style="width:${pct}%;"></div></div>
      <span class="ind-bar-n">${i.valor}</span>
    </div>`;
  });
  h += `</div></div>`;
  return h;
}

// ── FICHAS DOS INDICADORES (formato simplificado) ────────────────────────────
const FICHAS_FISIO = {
  perm_total_altas: {
    nome: 'Total de altas',
    conceituacao: 'Número de pacientes que saíram da UTI no período (alta para enfermaria, óbito ou transferência).',
    formula: 'Contagem de registros em uti_alta_log com dataAlta dentro do período.'
  },
  perm_mortalidade: {
    nome: 'Taxa de mortalidade intra-UTI',
    conceituacao: 'Proporção de pacientes que foram a óbito durante a internação na UTI em relação ao total de pacientes que saíram.',
    formula: '(óbitos / total de altas) × 100',
    importancia: 'Indicador-chave de qualidade assistencial e gravidade dos pacientes admitidos.'
  },
  perm_media: {
    nome: 'Permanência média',
    conceituacao: 'Tempo médio de internação na UTI dos pacientes que receberam alta no período.',
    formula: 'Σ (dataAlta − admUTI) / total de altas, em dias.'
  },
  perm_pacdia_vmi: {
    nome: 'Pacientes-dia em VMI',
    conceituacao: 'Número de evoluções de fisioterapia no período em que o suporte ventilatório era VMI. Cada evolução corresponde a um turno (12h), portanto 2 evoluções = 1 paciente-dia.',
    formula: 'Σ evoluções com sv="VMI" no período ÷ 2.'
  },
  desm_taxa: {
    nome: 'Taxa de desmame ventilatório',
    conceituacao: 'Proporção de pacientes que receberam alta da UTI após terem estado em VMI e que saíram extubados (não em VMI). Corresponde à fração de pacientes que conseguiram desmamar do ventilador.',
    formula: '(pacientes com VMI em algum turno e sem VMI no último turno antes da alta) / (pacientes que tiveram VMI em algum momento)',
    importancia: 'Indicador-chave de eficácia do desmame. Inclui sucesso de desmame e extubação. Não inclui pacientes que foram a óbito intubados.'
  },
  desm_sucesso_ext: {
    nome: 'Taxa de sucesso de extubação',
    conceituacao: 'Proporção de extubações sem necessidade de re-intubação em até 48h.',
    formula: '(extubações sem RE-IOT em ≤48h) / (total de extubações com data registrada)',
    importancia: 'Padrão clínico: re-IOT em ≤48h define falha de extubação (consenso AMIB/ATS).'
  },
  desm_falha_ext: {
    nome: 'Taxa de falha de extubação',
    conceituacao: 'Proporção de extubações que necessitaram de re-intubação em até 48h.',
    formula: '(extubações com RE-IOT em ≤48h) / (total de extubações)',
    importancia: 'Falha de extubação está associada a maior mortalidade, maior tempo de VMI e maior permanência.'
  },
  desm_tre: {
    nome: 'Taxa de sucesso do TRE',
    conceituacao: 'Proporção de testes de respiração espontânea (TRE) que tiveram resultado "Sucesso" no acompanhamento diário.',
    formula: '(colunas com tre="Sucesso") / (colunas com tre preenchido)',
    importancia: 'TRE é a etapa-chave do processo de desmame ventilatório.'
  },
  desm_tempo_vmi: {
    nome: 'Tempo médio em VMI até extubação',
    conceituacao: 'Média dos dias de TOT registrados nas evoluções no momento da extubação (data EXTB preenchida).',
    formula: 'Σ dtot nas evoluções com EXTB no período / nº de extubações.'
  },
  mob_cobertura: {
    nome: 'Cobertura fisioterapêutica',
    conceituacao: 'Proporção de turnos com paciente em leito que receberam evolução de fisioterapia no período.',
    formula: '(turnos com fisio_ev) / (turnos com paciente ocupando leito)',
    importancia: 'Indicador operacional de adesão da equipe ao protocolo de evolução por turno.'
  },
  mob_precoce: {
    nome: 'Mobilização precoce',
    conceituacao: 'Proporção de evoluções com Johns Hopkins ≥ 3 (paciente sentado à beira do leito ou mais ativo).',
    formula: '(evoluções com jh ≥ 3) / (evoluções com jh preenchido)',
    importancia: 'Mobilização precoce reduz fraqueza adquirida na UTI, delírio e tempo de VMI.'
  },
  mob_jh_dist: {
    nome: 'Distribuição Johns Hopkins',
    conceituacao: 'Frequência de cada nível (1–8) da escala Johns Hopkins de mobilidade nas evoluções do período.',
    formula: 'Contagem de evoluções por nível jh.'
  }
};

function abrirFichaIndicador(id){
  const f = FICHAS_FISIO[id];
  if (!f) return;
  document.getElementById('ficha-titulo').textContent = f.nome;
  let h = `<div style="font-size:.82rem;line-height:1.5;">
    <p><strong>Conceituação:</strong> ${f.conceituacao}</p>
    ${f.formula ? `<p><strong>Fórmula:</strong> ${f.formula}</p>` : ''}
    ${f.importancia ? `<p><strong>Importância:</strong> ${f.importancia}</p>` : ''}
  </div>
  <div style="display:flex;justify-content:flex-end;margin-top:10px;">
    <button class="btn btn-sec btn-sm" onclick="fecharFichaIndicador()">Fechar</button>
  </div>`;
  document.getElementById('ficha-body').innerHTML = h;
  document.getElementById('modal-ficha').classList.add('show');
}
function fecharFichaIndicador(){
  document.getElementById('modal-ficha').classList.remove('show');
}

// ── RENDERIZAÇÃO ─────────────────────────────────────────────────────────────
async function renderIndicadores(){
  const periodo = _indPeriodo();
  if (!periodo) { toast('Informe o período personalizado', true); return; }
  if (!_indCache) await _carregarDadosInd();
  _renderCategoriaInd();
}

function _renderCategoriaInd(){
  const periodo = _indPeriodo();
  if (!periodo || !_indCache) return;
  const fn = {
    permanencia: _indPermanencia,
    desmame:     _indDesmame,
    mobilizacao: _indMobilizacao
  }[_indCategoriaAtiva];
  if (!fn) return;
  const cont = document.getElementById('ind-conteudo');
  cont.innerHTML = `<div style="font-size:.78rem;color:var(--muted);margin-bottom:8px;">Período: <strong>${periodo.rotulo}</strong></div>` + fn(periodo);
}

// ── 1. MORTALIDADE & PERMANÊNCIA ─────────────────────────────────────────────
function _indPermanencia(periodo){
  const { admissoes, altas, evolucoes } = _indCache;
  const altasPer = altas.filter(a => _dentroPeriodo(a.dataAlta, periodo));
  const total = altasPer.length;

  // Mortalidade
  const obitos = altasPer.filter(a => a.tipoAlta === 'Óbito').length;

  // Permanência média (altas do período)
  const permanencias = altasPer
    .map(a => _diasEntre(a.admUTI, a.dataAlta))
    .filter(d => d !== null);
  const permMedia = permanencias.length
    ? (permanencias.reduce((s,x) => s+x, 0) / permanencias.length).toFixed(1)
    : '–';

  // Pacientes-dia em VMI: cada evolução = 12h; 2 evoluções = 1 dia
  const evVMI = evolucoes.filter(e => _dentroPeriodo(e.data, periodo) && e.sv === 'VMI').length;
  const pacDiaVMI = (evVMI / 2).toFixed(1);

  let h = '<div class="ind-grid">';
  h += _cardInd('Total de altas', total, 'no período', '', 'perm_total_altas');
  h += _cardInd('Taxa de mortalidade', _pct(obitos, total),
    `${obitos} óbito${obitos===1?'':'s'}`, obitos > 0 ? 'vermelho' : 'verde', 'perm_mortalidade');
  h += _cardInd('Permanência média',
    permMedia !== '–' ? permMedia + ' dias' : '–',
    `${permanencias.length} altas`, '', 'perm_media');
  h += _cardInd('Pacientes-dia em VMI', pacDiaVMI,
    `${evVMI} evoluções`, 'roxo', 'perm_pacdia_vmi');
  h += '</div>';
  return h;
}

// ── 2. DESMAME & EXTUBAÇÃO ───────────────────────────────────────────────────
function _indDesmame(periodo){
  const { admissoes, altas, evolucoes, acompanhamentos } = _indCache;

  // Agrupa evoluções por (leito, paciente) baseado na admissão para identificar
  // quem teve VMI em algum momento e qual o último estado antes da alta
  const altasPer = altas.filter(a => _dentroPeriodo(a.dataAlta, periodo) && a.tipoAlta !== 'Óbito');

  let teveVMI = 0, desmamou = 0;
  altasPer.forEach(a => {
    // Evoluções desse paciente: mesmo leito + entre admUTI e dataAlta
    const admStr = a.admUTI || '';
    const altaStr = a.dataAlta || '';
    if (!admStr || !altaStr) return;
    const evs = evolucoes.filter(e =>
      e.leito === a.leito &&
      e.data && e.data >= admStr && e.data <= altaStr
    ).sort((x,y) => (x.data + x.turno).localeCompare(y.data + y.turno));
    if (!evs.length) return;
    const houveVMI = evs.some(e => e.sv === 'VMI');
    if (!houveVMI) return;
    teveVMI++;
    // Último estado antes da alta
    const ultimo = evs[evs.length - 1];
    if (ultimo.sv && ultimo.sv !== 'VMI') desmamou++;
  });

  // Sucesso/falha de extubação: olha cada evolução com EXTB preenchido
  // Falha = re-IOT em ≤48h após EXTB
  const extubacoes = [];
  evolucoes.forEach(e => {
    if (!e.extb || !_dentroPeriodo(e.extb, periodo)) return;
    // Evita duplicata: cada par (leito, extb) conta uma vez
    const key = `${e.leito}_${e.extb}`;
    if (extubacoes.find(x => x.key === key)) return;
    extubacoes.push({ key, leito: e.leito, extb: e.extb, reiot: e.reiot || null });
  });
  let falhas = 0;
  extubacoes.forEach(x => {
    if (x.reiot) {
      const d = _diasEntre(x.extb, x.reiot);
      if (d !== null && d <= 2) falhas++; // ≤48h ≈ 2 dias corridos
    }
  });
  const totExt = extubacoes.length;
  const sucessos = totExt - falhas;

  // TRE no acompanhamento: percorre colunas
  let treSucesso = 0, treTotal = 0;
  acompanhamentos.forEach(ac => {
    (ac.colunas || []).forEach(c => {
      if (!_dentroPeriodo(c.data, periodo)) return;
      if (!c.tre) return;
      treTotal++;
      if (c.tre === 'Sucesso') treSucesso++;
    });
  });

  // Tempo médio em VMI até extubação: dtot nas evoluções com EXTB no período
  const dtotsExt = [];
  evolucoes.forEach(e => {
    if (!e.extb || !_dentroPeriodo(e.extb, periodo)) return;
    const d = parseInt(e.dtot);
    if (!isNaN(d) && d > 0) dtotsExt.push(d);
  });
  const tempoMedioVMI = dtotsExt.length
    ? (dtotsExt.reduce((s,x) => s+x, 0) / dtotsExt.length).toFixed(1)
    : '–';

  let h = '<div class="ind-grid">';
  h += _cardInd('Taxa de desmame', _pct(desmamou, teveVMI),
    `${desmamou}/${teveVMI} pacientes`, teveVMI > 0 ? 'verde' : '', 'desm_taxa');
  h += _cardInd('Sucesso de extubação', _pct(sucessos, totExt),
    `${sucessos}/${totExt} extubações`, sucessos === totExt && totExt > 0 ? 'verde' : '', 'desm_sucesso_ext');
  h += _cardInd('Falha de extubação', _pct(falhas, totExt),
    `${falhas} re-IOT em ≤48h`, falhas > 0 ? 'vermelho' : 'verde', 'desm_falha_ext');
  h += _cardInd('Sucesso do TRE', _pct(treSucesso, treTotal),
    `${treSucesso}/${treTotal} testes`, '', 'desm_tre');
  h += _cardInd('Tempo médio em VMI',
    tempoMedioVMI !== '–' ? tempoMedioVMI + ' dias' : '–',
    `${dtotsExt.length} extubações`, 'roxo', 'desm_tempo_vmi');
  h += '</div>';
  return h;
}

// ── 3. MOBILIZAÇÃO & COBERTURA ───────────────────────────────────────────────
function _indMobilizacao(periodo){
  const { admissoes, altas, evolucoes } = _indCache;

  // Cobertura: turnos com fisio_ev no período / turnos esperados
  // Turnos esperados = soma dos pacientes-dia × 2 (DIURNO + NOTURNO) no período
  let turnosEsperados = 0;
  admissoes.forEach(adm => {
    if (!adm.admUTI) return;
    const inicio = _dataLocal(adm.admUTI);
    if (!inicio) return;
    const alta = altas.find(a =>
      a.leito === adm.leito &&
      a.paciente === adm.paciente &&
      _dataLocal(a.dataAlta) >= inicio
    );
    const fimInt = alta ? _dataLocal(alta.dataAlta) : new Date();
    const s = inicio > periodo.inicio ? inicio : periodo.inicio;
    const e = fimInt < periodo.fim ? fimInt : periodo.fim;
    if (e >= s) turnosEsperados += (Math.floor((e-s)/86400000) + 1) * 2;
  });
  const turnosCobertos = evolucoes.filter(e => _dentroPeriodo(e.data, periodo)).length;

  // Mobilização precoce: jh ≥ 3
  const evComJh = evolucoes.filter(e => _dentroPeriodo(e.data, periodo) && e.jh && !isNaN(parseInt(e.jh)));
  const mobPrecoce = evComJh.filter(e => parseInt(e.jh) >= 3).length;

  // Distribuição JH
  const distJh = {};
  for (let i = 1; i <= 8; i++) distJh[i] = 0;
  evComJh.forEach(e => {
    const n = parseInt(e.jh);
    if (n >= 1 && n <= 8) distJh[n]++;
  });
  const distList = Object.entries(distJh)
    .filter(([_, v]) => v > 0)
    .map(([k, v]) => ({ label: `Nível ${k}`, valor: v }));

  let h = '<div class="ind-grid">';
  h += _cardInd('Cobertura fisioterapêutica', _pct(turnosCobertos, turnosEsperados),
    `${turnosCobertos}/${turnosEsperados} turnos`, '', 'mob_cobertura');
  h += _cardInd('Mobilização precoce (JH≥3)', _pct(mobPrecoce, evComJh.length),
    `${mobPrecoce}/${evComJh.length} evoluções`, mobPrecoce > 0 ? 'verde' : '', 'mob_precoce');
  h += _cardInd('Total de evoluções', evolucoes.filter(e => _dentroPeriodo(e.data, periodo)).length,
    'no período', 'roxo');
  h += '</div>';

  h += _rankingBarras('Distribuição Johns Hopkins (1–8)', distList, null, 'mob_jh_dist');
  return h;
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
