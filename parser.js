// Lê o texto de uma conversa exportada do WhatsApp (iPhone ou Android).
// Formatos:
//   iPhone : [23/10/2025 16:13:05] Nome: texto
//   Android: 23/10/2025 16:13 - Nome: texto
// Linhas sem data no início continuam a mensagem anterior.
(function (raiz) {
  const HORA = '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:\\s?([AaPp])\\.?[Mm]\\.?)?';
  const DATA = '(\\d{1,2})[\\/.](\\d{1,2})[\\/.](\\d{2,4}),?\\s+' + HORA;
  const RE_IOS = new RegExp('^\\[' + DATA + '\\]\\s(.*)$');
  const RE_ANDROID = new RegExp('^' + DATA + '\\s-\\s(.*)$');

  function limpar(s) {
    return s.replace(/[‎‏‪-‮]/g, '').replace(/[  ]/g, ' ');
  }

  function paraTimestamp(m) {
    let [, a, b, ano, h, min, seg, ampm] = m;
    let dia = +a, mes = +b;
    if (mes > 12 && dia <= 12) [dia, mes] = [mes, dia]; // formato mês/dia
    ano = +ano;
    if (ano < 100) ano += 2000;
    h = +h;
    if (ampm) {
      const pm = ampm.toLowerCase() === 'p';
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    }
    return new Date(ano, mes - 1, dia, h, +min, +(seg || 0)).getTime();
  }

  function lerConversa(texto) {
    const mensagens = [];
    let atual = null;
    for (const bruta of texto.replace(/^﻿/, '').split(/\r?\n/)) {
      const linha = limpar(bruta);
      const m = RE_IOS.exec(linha) || RE_ANDROID.exec(linha);
      if (m) {
        const resto = m[m.length - 1];
        const i = resto.indexOf(': ');
        atual = {
          data: paraTimestamp(m),
          autor: i > 0 ? resto.slice(0, i) : '',
          texto: i > 0 ? resto.slice(i + 2) : resto,
          sistema: i <= 0
        };
        mensagens.push(atual);
      } else if (atual) {
        atual.texto += '\n' + linha;
      }
    }
    return mensagens;
  }

  // "Conversa do WhatsApp com Fulano.zip" / "WhatsApp Chat - Fulano.txt" -> "Fulano"
  function nomeDoArquivo(arquivo) {
    let n = arquivo.replace(/\.(zip|txt)$/i, '');
    n = n.replace(/^(conversa do whatsapp com|whatsapp chat with|whatsapp chat -|conversa do whatsapp -)\s*/i, '');
    return n.trim() || 'Conversa';
  }

  const api = { lerConversa, nomeDoArquivo };
  if (typeof module !== 'undefined') module.exports = api;
  else raiz.Parser = api;
})(typeof self !== 'undefined' ? self : this);
