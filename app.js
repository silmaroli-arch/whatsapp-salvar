// Armazenamento local (IndexedDB). Nada sai do dispositivo.
const DB_NOME = 'mensagens-whatsapp';
const S_MSG = 'mensagens';   // mensagens soltas
const S_CONV = 'conversas';  // conversas importadas
const S_MID = 'midias';      // fotos, vídeos, áudios e documentos (chave "idConversa|arquivo")

function abrirDB() {
  return new Promise((ok, erro) => {
    const req = indexedDB.open(DB_NOME, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(S_MID)) db.createObjectStore(S_MID, { keyPath: 'k' });
      if (!db.objectStoreNames.contains(S_MSG)) db.createObjectStore(S_MSG, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(S_CONV)) db.createObjectStore(S_CONV, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  });
}

async function tx(loja, modo, fn) {
  const db = await abrirDB();
  return new Promise((ok, erro) => {
    const t = db.transaction(loja, modo);
    const r = fn(t.objectStore(loja));
    t.oncomplete = () => ok(r && r.result);
    t.onerror = () => erro(t.error);
  });
}

const todas = loja => tx(loja, 'readonly', s => s.getAll());
const gravar = (loja, v) => tx(loja, 'readwrite', s => s.put(v));
const remover = (loja, id) => tx(loja, 'readwrite', s => s.delete(id));
const lerMidia = k => tx(S_MID, 'readonly', s => s.get(k));
const removerMidiasDe = id => tx(S_MID, 'readwrite', s => s.delete(IDBKeyRange.bound(`${id}|`, `${id}|￿`)));

const TIPOS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'],
  video: ['mp4', 'mov', 'm4v', '3gp'],
  audio: ['opus', 'ogg', 'm4a', 'mp3', 'aac', 'wav', 'amr']
};
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', '3gp': 'video/3gpp', opus: 'audio/ogg; codecs=opus', ogg: 'audio/ogg',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', wav: 'audio/wav', amr: 'audio/amr', pdf: 'application/pdf' };
const extensao = n => (n.split('.').pop() || '').toLowerCase();
const tipoDe = n => Object.keys(TIPOS).find(t => TIPOS[t].includes(extensao(n))) || 'outro';
const base = n => n.split('/').pop();

const $ = id => document.getElementById(id);

function aviso(msg) {
  const el = $('aviso');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => (el.hidden = true), 3000);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

const fmtData = t => new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const fmtDia = t => new Date(t).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' });

// ---------- Abas ----------
function mostrarAba(nome) {
  document.querySelectorAll('#abas button').forEach(b => b.classList.toggle('ativa', b.dataset.aba === nome));
  $('aba-conversas').hidden = nome !== 'conversas';
  $('aba-mensagens').hidden = nome !== 'mensagens';
  $('titulo').textContent = nome === 'conversas' ? 'Conversas' : 'Mensagens soltas';
}
$('abas').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) mostrarAba(b.dataset.aba);
});

// ---------- Conversas ----------
let conversas = [];
let aberta = null;      // conversa em leitura
let limite = 200;       // quantas mensagens mostrar

async function recarregarConversas() {
  conversas = (await todas(S_CONV)).sort((a, b) => b.fim - a.fim);
  desenharConversas();
  if (aberta) aberta = conversas.find(c => c.id === aberta.id) || null;
}

function desenharConversas() {
  $('sem-conversas').hidden = conversas.length > 0;
  $('lista-conversas').innerHTML = conversas.map(c => `
    <li class="conversa" data-id="${c.id}">
      <div class="nome">${esc(c.nome)}</div>
      <div class="meta"><span>${c.mensagens.length.toLocaleString('pt-BR')} mensagens</span><span>${fmtData(c.inicio)} → ${fmtData(c.fim)}</span></div>
    </li>`).join('');
}

const chave = m => `${m.data}|${m.autor}|${m.texto}`;

async function lerArquivo(arq) {
  if (/\.zip$/i.test(arq.name)) {
    const zip = await JSZip.loadAsync(arq);
    const txt = Object.values(zip.files).find(f => !f.dir && /\.txt$/i.test(f.name));
    if (!txt) throw new Error('O .zip não contém um arquivo .txt de conversa.');
    return { texto: await txt.async('string'), zip };
  }
  return { texto: await arq.text(), zip: null };
}

// Descobre qual arquivo de mídia a mensagem representa (iPhone: <anexo: X>, Android: X (arquivo anexado))
function nomeDaMidia(texto, nomes) {
  const l = texto.split('\n')[0].trim();
  const m = /^<(?:anexo|attached):\s*(.+)>$/i.exec(l) || /^(.+?)\s*\((?:arquivo anexado|file attached)\)$/i.exec(l);
  return m && nomes.has(m[1].trim()) ? m[1].trim() : null;
}

async function guardarMidias(idConversa, zip, nomes) {
  const arquivos = Object.values(zip.files).filter(f => !f.dir && !/\.txt$/i.test(f.name));
  let n = 0;
  for (const f of arquivos) {
    const nome = base(f.name);
    const blob = await f.async('blob');
    await gravar(S_MID, { k: `${idConversa}|${nome}`, nome, blob: new Blob([blob], { type: MIME[extensao(nome)] || 'application/octet-stream' }) });
    if (++n % 10 === 0 || n === arquivos.length) aviso(`Guardando mídia ${n}/${arquivos.length}…`);
  }
  return n;
}

async function importarConversas(arquivos) {
  for (const arq of arquivos) {
    try {
      if (arq.size > 1.5 * 1024 ** 3 && !confirm('Este arquivo é muito grande e pode travar o navegador. Continuar?')) continue;
      const { texto, zip } = await lerArquivo(arq);
      const novas = Parser.lerConversa(texto);
      if (!novas.length) { aviso(`Nenhuma mensagem reconhecida em ${arq.name}`); continue; }
      const nomes = new Set(zip ? Object.values(zip.files).filter(f => !f.dir && !/\.txt$/i.test(f.name)).map(f => base(f.name)) : []);
      for (const m of novas) if (!m.sistema) { const x = nomeDaMidia(m.texto, nomes); if (x) m.midia = x; }
      const nome = Parser.nomeDoArquivo(arq.name);
      const existente = conversas.find(c => c.nome.toLowerCase() === nome.toLowerCase());
      let conv, adicionadas;
      if (existente) {
        // Reimportar a mesma conversa: junta sem duplicar (e liga mídia a mensagens antigas)
        const porChave = new Map(existente.mensagens.map(m => [chave(m), m]));
        const extras = [];
        for (const m of novas) {
          const antiga = porChave.get(chave(m));
          if (!antiga) extras.push(m);
          else if (m.midia && !antiga.midia) antiga.midia = m.midia;
        }
        adicionadas = extras.length;
        conv = { ...existente, mensagens: existente.mensagens.concat(extras).sort((a, b) => a.data - b.data) };
      } else {
        adicionadas = novas.length;
        conv = { nome, mensagens: novas };
      }
      conv.inicio = conv.mensagens[0].data;
      conv.fim = conv.mensagens[conv.mensagens.length - 1].data;
      conv.importadoEm = Date.now();
      const idConv = await gravar(S_CONV, conv);
      let midias = 0;
      if (zip && nomes.size) {
        if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
        midias = await guardarMidias(idConv, zip, nomes);
      }
      await recarregarConversas();
      const extra = midias ? ` e ${midias} arquivos de mídia` : '';
      aviso(existente ? `${nome}: ${adicionadas} mensagens novas${extra}` : `${nome}: ${adicionadas} mensagens${extra} importadas`);
    } catch (e) {
      aviso(`Erro em ${arq.name}: ${e.message || 'arquivo inválido'}`);
    }
  }
}

$('arq-conversa').addEventListener('change', async e => {
  const arqs = [...e.target.files];
  e.target.value = '';
  if (arqs.length) await importarConversas(arqs);
});

$('lista-conversas').addEventListener('click', e => {
  const li = e.target.closest('li.conversa');
  if (!li) return;
  aberta = conversas.find(c => c.id === Number(li.dataset.id));
  limite = 200;
  $('busca-conversa').value = '';
  $('nome-conversa').textContent = aberta.nome;
  $('lista-view').hidden = true;
  $('leitura-view').hidden = false;
  desenharLeitura();
  window.scrollTo(0, 0);
});

$('voltar').addEventListener('click', () => {
  liberarUrls();
  aberta = null;
  $('leitura-view').hidden = true;
  $('lista-view').hidden = false;
});

$('apagar-conversa').addEventListener('click', async () => {
  if (!aberta || !confirm(`Apagar a conversa "${aberta.nome}" (${aberta.mensagens.length} mensagens)?`)) return;
  await remover(S_CONV, aberta.id);
  await removerMidiasDe(aberta.id);
  aberta = null;
  $('voltar').click();
  await recarregarConversas();
});

$('busca-conversa').addEventListener('input', () => { limite = 200; desenharLeitura(); });
$('mais').addEventListener('click', () => { limite += 200; desenharLeitura(); });

// Mídia é carregada só quando aparece na tela
let urls = [];
let observador = null;

function liberarUrls() {
  if (observador) observador.disconnect();
  urls.forEach(u => URL.revokeObjectURL(u));
  urls = [];
}

async function montarMidia(el) {
  const nome = el.dataset.nome;
  const rec = aberta && await lerMidia(`${aberta.id}|${nome}`);
  if (!rec) { el.textContent = `[mídia não disponível: ${nome}]`; el.classList.add('falta'); return; }
  const url = URL.createObjectURL(rec.blob);
  urls.push(url);
  const t = tipoDe(nome);
  if (t === 'image') el.innerHTML = `<a href="${url}" target="_blank"><img src="${url}" alt="${esc(nome)}"></a>`;
  else if (t === 'video') el.innerHTML = `<video src="${url}" controls preload="metadata" playsinline></video>`;
  else if (t === 'audio') el.innerHTML = `<audio src="${url}" controls preload="none"></audio>`;
  else el.innerHTML = `<a href="${url}" download="${esc(nome)}" target="_blank">📎 ${esc(nome)}</a>`;
  if (t === 'audio' || t === 'video') el.insertAdjacentHTML('beforeend', `<a class="baixar" href="${url}" download="${esc(nome)}">baixar</a>`);
}

function prepararMidias() {
  liberarUrls();
  const alvos = document.querySelectorAll('#mensagens-conversa .midia[data-nome]');
  if (!alvos.length) return;
  observador = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    observador.unobserve(e.target);
    montarMidia(e.target);
  }), { rootMargin: '400px' });
  alvos.forEach(el => observador.observe(el));
}

function desenharLeitura() {
  if (!aberta) return;
  const q = $('busca-conversa').value.trim().toLowerCase();
  const filtradas = q
    ? aberta.mensagens.filter(m => (m.texto + ' ' + m.autor).toLowerCase().includes(q))
    : aberta.mensagens;
  const visiveis = filtradas.slice(Math.max(0, filtradas.length - limite));

  // O primeiro remetente que não é "sistema" fica à esquerda, os demais à direita
  const autores = [...new Set(aberta.mensagens.filter(m => !m.sistema).map(m => m.autor))];
  let dia = '';
  $('mensagens-conversa').innerHTML = visiveis.map(m => {
    const d = fmtDia(m.data);
    const cab = d !== dia ? `<div class="dia">${esc(d)}</div>` : '';
    dia = d;
    if (m.sistema) return cab + `<div class="sistema">${esc(m.texto)}</div>`;
    const lado = autores.indexOf(m.autor) === 0 ? 'esq' : 'dir';
    const hora = new Date(m.data).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const legenda = m.midia ? m.texto.split('\n').slice(1).join('\n').trim() : '';
    const corpo = m.midia
      ? `<div class="midia" data-nome="${esc(m.midia)}">${esc(m.midia)}</div>` + (legenda ? `<div class="texto">${esc(legenda)}</div>` : '')
      : `<div class="texto">${esc(m.texto)}</div>`;
    return cab + `<div class="bolha ${lado}"><b>${esc(m.autor)}</b>${corpo}<span class="hora">${hora}</span></div>`;
  }).join('');
  prepararMidias();

  $('info-conversa').textContent = q
    ? `${filtradas.length} resultado(s)`
    : `${aberta.mensagens.length.toLocaleString('pt-BR')} mensagens`;
  $('mais').hidden = filtradas.length <= limite;
}

// ---------- Mensagens soltas ----------
let cache = [];

function desenhar() {
  const q = $('busca').value.trim().toLowerCase();
  const itens = cache
    .filter(m => !q || [m.texto, m.contato, (m.etiquetas || []).join(' ')].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.salvoEm - a.salvoEm);

  $('vazio').hidden = cache.length > 0;
  $('contagem').textContent = cache.length ? `${itens.length} de ${cache.length} mensagens` : '';
  $('lista').innerHTML = itens.map(m => `
    <li data-id="${m.id}">
      <div class="meta"><span>${esc(m.contato || 'WhatsApp')}</span><span>${fmtData(m.salvoEm)}</span></div>
      <div class="texto">${esc(m.texto)}</div>
      ${m.etiquetas?.length ? `<div class="etiquetas">${m.etiquetas.map(e => `<span class="etiqueta">${esc(e)}</span>`).join('')}</div>` : ''}
      <div class="botoes">
        <button data-acao="copiar">Copiar</button>
        <button data-acao="apagar">Apagar</button>
      </div>
    </li>`).join('');
}

async function recarregar() {
  cache = await todas(S_MSG);
  desenhar();
}

async function salvar({ texto, contato = '', etiquetas = [] }) {
  texto = (texto || '').trim();
  if (!texto) return false;
  await gravar(S_MSG, { texto, contato: contato.trim(), etiquetas, salvoEm: Date.now() });
  await recarregar();
  return true;
}

// Recebe conteúdo compartilhado (Android: Web Share Target; iPhone: atalho com ?text=)
async function tratarCompartilhamento() {
  const p = new URLSearchParams(location.search);
  const partes = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean);
  if (!partes.length) return;
  mostrarAba('mensagens');
  if (await salvar({ texto: partes.join('\n') })) aviso('Mensagem salva!');
  history.replaceState(null, '', location.pathname);
}

$('busca').addEventListener('input', desenhar);

$('form-novo').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const etiquetas = (f.get('etiquetas') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (await salvar({ texto: f.get('texto'), contato: f.get('contato'), etiquetas })) {
    e.target.reset();
    $('novo').open = false;
    aviso('Mensagem salva!');
  }
});

$('lista').addEventListener('click', async e => {
  const botao = e.target.closest('button');
  if (!botao) return;
  const id = Number(botao.closest('li').dataset.id);
  if (botao.dataset.acao === 'apagar' && confirm('Apagar esta mensagem?')) {
    await remover(S_MSG, id);
    await recarregar();
  } else if (botao.dataset.acao === 'copiar') {
    const m = cache.find(x => x.id === id);
    try { await navigator.clipboard.writeText(m.texto); aviso('Copiado'); } catch { aviso('Não foi possível copiar'); }
  }
});

// ---------- Backup ----------
$('btn-exportar').addEventListener('click', () => {
  const dados = { versao: 2, mensagens: cache, conversas };
  const blob = new Blob([JSON.stringify(dados)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `backup-mensagens-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('arq-importar').addEventListener('change', async e => {
  const arq = e.target.files[0];
  e.target.value = '';
  if (!arq) return;
  try {
    const d = JSON.parse(await arq.text());
    // aceita o formato antigo (lista de mensagens soltas) e o novo
    const soltas = Array.isArray(d) ? d : d.mensagens || [];
    const convs = Array.isArray(d) ? [] : d.conversas || [];
    for (const m of soltas) {
      if (m && m.texto) await gravar(S_MSG, { texto: String(m.texto), contato: m.contato || '', etiquetas: m.etiquetas || [], salvoEm: m.salvoEm || Date.now() });
    }
    for (const c of convs) {
      if (!c || !Array.isArray(c.mensagens)) continue;
      const { id, ...resto } = c;
      const ex = conversas.find(x => x.nome.toLowerCase() === c.nome.toLowerCase());
      if (ex) {
        const vistas = new Set(ex.mensagens.map(chave));
        const mensagens = ex.mensagens.concat(c.mensagens.filter(m => !vistas.has(chave(m)))).sort((a, b) => a.data - b.data);
        await gravar(S_CONV, { ...ex, mensagens, inicio: mensagens[0].data, fim: mensagens[mensagens.length - 1].data });
      } else {
        await gravar(S_CONV, resto);
      }
      await recarregarConversas();
    }
    await recarregar();
    await recarregarConversas();
    aviso('Backup restaurado');
  } catch { aviso('Arquivo de backup inválido'); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async () => {
  await recarregar();
  await recarregarConversas();
  await tratarCompartilhamento();
})();
