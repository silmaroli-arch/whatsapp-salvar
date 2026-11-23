// Armazenamento local (IndexedDB). Nada sai do dispositivo.
const DB_NOME = 'mensagens-whatsapp';
const S_MSG = 'mensagens';   // mensagens soltas
const S_CONV = 'conversas';  // conversas importadas

function abrirDB() {
  return new Promise((ok, erro) => {
    const req = indexedDB.open(DB_NOME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
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
    return txt.async('string');
  }
  return arq.text();
}

async function importarConversas(arquivos) {
  for (const arq of arquivos) {
    try {
      const novas = Parser.lerConversa(await lerArquivo(arq));
      if (!novas.length) { aviso(`Nenhuma mensagem reconhecida em ${arq.name}`); continue; }
      const nome = Parser.nomeDoArquivo(arq.name);
      const existente = conversas.find(c => c.nome.toLowerCase() === nome.toLowerCase());
      let conv, adicionadas;
      if (existente) {
        // Reimportar a mesma conversa: junta sem duplicar
        const vistas = new Set(existente.mensagens.map(chave));
        const extras = novas.filter(m => !vistas.has(chave(m)));
        adicionadas = extras.length;
        conv = { ...existente, mensagens: existente.mensagens.concat(extras).sort((a, b) => a.data - b.data) };
      } else {
        adicionadas = novas.length;
        conv = { nome, mensagens: novas };
      }
      conv.inicio = conv.mensagens[0].data;
      conv.fim = conv.mensagens[conv.mensagens.length - 1].data;
      conv.importadoEm = Date.now();
      await gravar(S_CONV, conv);
      await recarregarConversas();
      aviso(existente ? `${nome}: ${adicionadas} mensagens novas` : `${nome}: ${adicionadas} mensagens importadas`);
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
  aberta = null;
  $('leitura-view').hidden = true;
  $('lista-view').hidden = false;
});

$('apagar-conversa').addEventListener('click', async () => {
  if (!aberta || !confirm(`Apagar a conversa "${aberta.nome}" (${aberta.mensagens.length} mensagens)?`)) return;
  await remover(S_CONV, aberta.id);
  aberta = null;
  $('voltar').click();
  await recarregarConversas();
});

$('busca-conversa').addEventListener('input', () => { limite = 200; desenharLeitura(); });
$('mais').addEventListener('click', () => { limite += 200; desenharLeitura(); });

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
    return cab + `<div class="bolha ${lado}"><b>${esc(m.autor)}</b><div class="texto">${esc(m.texto)}</div><span class="hora">${hora}</span></div>`;
  }).join('');

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
