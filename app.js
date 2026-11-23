// Armazenamento local (IndexedDB). Nada sai do dispositivo.
const DB_NOME = 'mensagens-whatsapp';
const STORE = 'mensagens';

function abrirDB() {
  return new Promise((ok, erro) => {
    const req = indexedDB.open(DB_NOME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  });
}

async function tx(modo, fn) {
  const db = await abrirDB();
  return new Promise((ok, erro) => {
    const t = db.transaction(STORE, modo);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => ok(r && r.result);
    t.onerror = () => erro(t.error);
  });
}

const todas = () => tx('readonly', s => s.getAll());
const adicionar = m => tx('readwrite', s => s.add(m));
const remover = id => tx('readwrite', s => s.delete(id));

const $ = id => document.getElementById(id);
let cache = [];

function aviso(msg) {
  const el = $('aviso');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 2500);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function desenhar() {
  const q = $('busca').value.trim().toLowerCase();
  const itens = cache
    .filter(m => !q || [m.texto, m.contato, (m.etiquetas || []).join(' ')].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.salvoEm - a.salvoEm);

  $('vazio').hidden = cache.length > 0;
  $('contagem').textContent = cache.length ? `${itens.length} de ${cache.length} mensagens` : '';
  $('lista').innerHTML = itens.map(m => `
    <li data-id="${m.id}">
      <div class="meta"><span>${esc(m.contato || 'WhatsApp')}</span><span>${new Date(m.salvoEm).toLocaleString('pt-BR')}</span></div>
      <div class="texto">${esc(m.texto)}</div>
      ${m.etiquetas?.length ? `<div class="etiquetas">${m.etiquetas.map(e => `<span class="etiqueta">${esc(e)}</span>`).join('')}</div>` : ''}
      <div class="botoes">
        <button data-acao="copiar">Copiar</button>
        <button data-acao="apagar">Apagar</button>
      </div>
    </li>`).join('');
}

async function recarregar() {
  cache = await todas();
  desenhar();
}

async function salvar({ texto, contato = '', etiquetas = [] }) {
  texto = (texto || '').trim();
  if (!texto) return false;
  await adicionar({ texto, contato: contato.trim(), etiquetas, salvoEm: Date.now() });
  await recarregar();
  return true;
}

// Recebe conteúdo compartilhado pelo WhatsApp (Web Share Target, via query string)
async function tratarCompartilhamento() {
  const p = new URLSearchParams(location.search);
  const partes = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean);
  if (!partes.length) return;
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
    await remover(id);
    await recarregar();
  } else if (botao.dataset.acao === 'copiar') {
    const m = cache.find(x => x.id === id);
    try { await navigator.clipboard.writeText(m.texto); aviso('Copiado'); } catch { aviso('Não foi possível copiar'); }
  }
});

$('btn-exportar').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(cache, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mensagens-whatsapp-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('arq-importar').addEventListener('change', async e => {
  const arq = e.target.files[0];
  if (!arq) return;
  try {
    const dados = JSON.parse(await arq.text());
    if (!Array.isArray(dados)) throw new Error();
    for (const m of dados) {
      if (m && m.texto) await adicionar({ texto: String(m.texto), contato: m.contato || '', etiquetas: m.etiquetas || [], salvoEm: m.salvoEm || Date.now() });
    }
    await recarregar();
    aviso('Backup importado');
  } catch { aviso('Arquivo inválido'); }
  e.target.value = '';
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async () => {
  await recarregar();
  await tratarCompartilhamento();
})();
