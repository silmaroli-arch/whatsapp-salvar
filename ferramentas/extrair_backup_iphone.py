#!/usr/bin/env python3
"""
Extrai as conversas do WhatsApp de um backup NÃO criptografado do iPhone (feito no PC)
e gera um .zip por conversa no mesmo formato da exportação do WhatsApp
(_chat.txt + mídias), pronto para importar no app "Salvar Mensagens".

Tudo roda localmente. Só usa a biblioteca padrão do Python.

Exemplos:
  python extrair_backup_iphone.py --listar
  python extrair_backup_iphone.py --saida C:\\Users\\voce\\Desktop\\conversas
  python extrair_backup_iphone.py --apenas "Maria" --sem-midia
"""
import argparse
import datetime as dt
import os
import plistlib
import re
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

DOMINIO = 'AppDomainGroup-group.net.whatsapp.WhatsApp.shared'
EPOCA_APPLE = 978307200  # 2001-01-01 em segundos Unix
LRM = '\u200e'


def pastas_de_backup():
    candidatos = [
        Path.home() / 'Apple' / 'MobileSync' / 'Backup',
        Path(os.environ.get('APPDATA', '')) / 'Apple Computer' / 'MobileSync' / 'Backup',
        Path.home() / 'Library' / 'Application Support' / 'MobileSync' / 'Backup',  # macOS
    ]
    pacotes = Path(os.environ.get('LOCALAPPDATA', '')) / 'Packages'
    if pacotes.exists():
        for p in pacotes.glob('AppleInc.AppleDevices*'):
            candidatos.append(p / 'LocalCache' / 'Roaming' / 'Apple Computer' / 'MobileSync' / 'Backup')
    return [c for c in candidatos if c.exists()]


def achar_backup(explicito):
    if explicito:
        return Path(explicito)
    achados = []
    for base in pastas_de_backup():
        for d in base.iterdir():
            if (d / 'Manifest.db').exists() and (d / 'Manifest.plist').exists():
                achados.append(d)
    if not achados:
        sys.exit('Nenhum backup encontrado. Use --backup CAMINHO_DA_PASTA_DO_BACKUP.')
    return max(achados, key=lambda d: (d / 'Manifest.plist').stat().st_mtime)


def verificar_criptografia(backup):
    info = plistlib.loads((backup / 'Manifest.plist').read_bytes())
    if info.get('IsEncrypted'):
        sys.exit(
            'Este backup é criptografado e esta ferramenta não lê backups criptografados.\n'
            'Faça um novo backup SEM criptografia (desmarque "Criptografar backup local" no\n'
            'app Dispositivos Apple ou no iTunes) e rode de novo. Depois apague esse backup.'
        )
    return info


class Backup:
    def __init__(self, pasta):
        self.pasta = pasta
        self.man = sqlite3.connect(f'file:{(pasta / "Manifest.db").as_posix()}?mode=ro', uri=True)

    def arquivo(self, caminho_relativo):
        """Caminho real, dentro do backup, de um arquivo do WhatsApp."""
        linha = self.man.execute(
            'SELECT fileID FROM Files WHERE domain=? AND relativePath=?', (DOMINIO, caminho_relativo)
        ).fetchone()
        if not linha:
            return None
        p = self.pasta / linha[0][:2] / linha[0]
        return p if p.exists() else None


def colunas(con, tabela):
    return {r[1] for r in con.execute(f'PRAGMA table_info({tabela})')}


def nome_seguro(s):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', s).strip(' .')
    return s[:80] or 'Conversa'


def jid_para_nome(jid):
    return (jid or '').split('@')[0]


class Banco:
    def __init__(self, caminho):
        self.con = sqlite3.connect(f'file:{caminho.as_posix()}?mode=ro', uri=True)
        self.con.row_factory = sqlite3.Row
        self.msg_cols = colunas(self.con, 'ZWAMESSAGE')
        self.ses_cols = colunas(self.con, 'ZWACHATSESSION')
        self.tem_midia = bool(colunas(self.con, 'ZWAMEDIAITEM'))
        self.tem_membro = bool(colunas(self.con, 'ZWAGROUPMEMBER'))
        self.tem_push = bool(colunas(self.con, 'ZWAPROFILEPUSHNAME'))
        self.push = {}
        if self.tem_push:
            for r in self.con.execute('SELECT ZJID, ZPUSHNAME FROM ZWAPROFILEPUSHNAME'):
                if r['ZJID'] and r['ZPUSHNAME']:
                    self.push[r['ZJID']] = r['ZPUSHNAME']
        self.membros = {}
        if self.tem_membro:
            mc = colunas(self.con, 'ZWAGROUPMEMBER')
            nome_col = 'ZCONTACTNAME' if 'ZCONTACTNAME' in mc else None
            for r in self.con.execute('SELECT Z_PK, ZMEMBERJID' + (f', {nome_col}' if nome_col else '') + ' FROM ZWAGROUPMEMBER'):
                jid = r['ZMEMBERJID']
                nome = (r[nome_col] if nome_col else None) or self.push.get(jid) or jid_para_nome(jid)
                self.membros[r['Z_PK']] = nome

    def conversas(self):
        c = self.ses_cols
        sql = ('SELECT s.Z_PK AS pk, s.ZCONTACTJID AS jid, s.ZPARTNERNAME AS nome, '
               + ('s.ZSESSIONTYPE' if 'ZSESSIONTYPE' in c else '0') + ' AS tipo, '
               '(SELECT COUNT(*) FROM ZWAMESSAGE m WHERE m.ZCHATSESSION = s.Z_PK) AS total '
               'FROM ZWACHATSESSION s ORDER BY total DESC')
        out = []
        for r in self.con.execute(sql):
            jid = r['jid'] or ''
            if r['total'] == 0 or jid.startswith('status@') or jid.endswith('@broadcast'):
                continue
            nome = r['nome'] or self.push.get(jid) or jid_para_nome(jid) or f'Conversa {r["pk"]}'
            out.append({'pk': r['pk'], 'jid': jid, 'nome': nome, 'grupo': jid.endswith('@g.us'), 'total': r['total']})
        return out

    def mensagens(self, pk):
        m = self.msg_cols
        col = lambda n, alt='NULL': f'm.{n}' if n in m else alt
        join = ''
        midia = 'NULL AS caminho, NULL AS titulo'
        if self.tem_midia and 'ZMEDIAITEM' in m:
            join = 'LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM'
            mic = colunas(self.con, 'ZWAMEDIAITEM')
            midia = ('mi.ZMEDIALOCALPATH AS caminho, ' if 'ZMEDIALOCALPATH' in mic else 'NULL AS caminho, ') + \
                    ('mi.ZTITLE AS titulo' if 'ZTITLE' in mic else 'NULL AS titulo')
        sql = (f'SELECT {col("ZMESSAGEDATE")} AS data, {col("ZISFROMME", "0")} AS meu, {col("ZTEXT")} AS texto, '
               f'{col("ZFROMJID")} AS de, {col("ZGROUPMEMBER")} AS membro, {col("ZPUSHNAME")} AS push, '
               f'{col("ZMESSAGETYPE", "0")} AS tipo, {midia} '
               f'FROM ZWAMESSAGE m {join} WHERE m.ZCHATSESSION = ? ORDER BY m.ZMESSAGEDATE, m.Z_PK')
        return self.con.execute(sql, (pk,))

    def autor(self, msg, conversa, meu_nome):
        if msg['meu']:
            return meu_nome
        if conversa['grupo']:
            if msg['membro'] in self.membros:
                return self.membros[msg['membro']]
            return msg['push'] or self.push.get(msg['de']) or jid_para_nome(msg['de']) or 'Participante'
        return conversa['nome']


def formatar_data(segundos):
    return dt.datetime.fromtimestamp((segundos or 0) + EPOCA_APPLE).strftime('%d/%m/%Y %H:%M:%S')


def exportar_conversa(bd, backup, conversa, saida, meu_nome, com_midia):
    linhas = []
    arquivos = {}  # nome no zip -> caminho no backup
    faltando = 0
    for m in bd.mensagens(conversa['pk']):
        quando = formatar_data(m['data'])
        texto = m['texto'] or ''
        autor = bd.autor(m, conversa, meu_nome)
        if m['caminho']:
            nome = os.path.basename(m['caminho'])
            real = backup.arquivo('Message/' + m['caminho']) if com_midia else None
            if real:
                if nome in arquivos and arquivos[nome] != real:
                    nome = f'{real.parent.name}_{nome}'
                arquivos[nome] = real
                corpo = f'{LRM}<anexo: {nome}>'
            else:
                faltando += 1
                corpo = f'{LRM}<mídia não disponível: {nome}>'
            if texto:
                corpo += '\n' + texto
            linhas.append(f'{LRM}[{quando}] {autor}: {corpo}')
        elif texto and m['tipo'] in (0, None):
            linhas.append(f'{LRM}[{quando}] {autor}: {texto}')
        elif texto:
            # mensagens de sistema (entrou, saiu, mudou assunto…) ou tipos especiais com texto
            linhas.append(f'{LRM}[{quando}] {autor}: {texto}' if m['tipo'] in (1, 2, 3, 7, 8, 11) else f'{LRM}[{quando}] {texto}')
        elif m['tipo'] == 14:
            linhas.append(f'{LRM}[{quando}] {autor}: Esta mensagem foi apagada.')
    destino = saida / f'Conversa do WhatsApp com {nome_seguro(conversa["nome"])}.zip'
    n = 2
    while destino.exists():
        destino = destino.with_name(f'Conversa do WhatsApp com {nome_seguro(conversa["nome"])} ({n}).zip')
        n += 1
    with zipfile.ZipFile(destino, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('_chat.txt', '\n'.join(linhas) + '\n')
        for nome, real in arquivos.items():
            z.write(real, nome)  # mídia já vem comprimida; o custo extra é pequeno
    return destino, len(linhas), len(arquivos), faltando


def main():
    for fluxo in (sys.stdout, sys.stderr):
        try:
            fluxo.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    ap = argparse.ArgumentParser(description='Extrai conversas do WhatsApp de um backup do iPhone.')
    ap.add_argument('--backup', help='Pasta do backup (padrão: o mais recente encontrado)')
    ap.add_argument('--saida', default='conversas_whatsapp', help='Pasta de saída dos .zip')
    ap.add_argument('--listar', action='store_true', help='Só lista as conversas e sai')
    ap.add_argument('--apenas', help='Exporta só conversas cujo nome contém este texto')
    ap.add_argument('--sem-grupos', action='store_true')
    ap.add_argument('--sem-midia', action='store_true')
    ap.add_argument('--meu-nome', default='Eu', help='Como aparecerão as suas mensagens')
    args = ap.parse_args()

    backup_dir = achar_backup(args.backup)
    verificar_criptografia(backup_dir)
    print(f'Backup: {backup_dir.name[:8]}...  (modificado em {dt.datetime.fromtimestamp((backup_dir / "Manifest.plist").stat().st_mtime):%d/%m/%Y %H:%M})')

    backup = Backup(backup_dir)
    banco_real = backup.arquivo('ChatStorage.sqlite')
    if not banco_real:
        sys.exit('O WhatsApp não foi encontrado neste backup (ChatStorage.sqlite ausente).')

    # No Windows o SQLite precisa estar fechado para a pasta temporária ser apagada
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        copia = Path(tmp) / 'ChatStorage.sqlite'
        shutil.copy(banco_real, copia)
        for ext in ('-wal', '-shm'):  # se existirem, o SQLite precisa deles
            extra = backup.arquivo('ChatStorage.sqlite' + ext)
            if extra:
                shutil.copy(extra, str(copia) + ext)
        bd = Banco(copia)
        convs = bd.conversas()
        if args.sem_grupos:
            convs = [c for c in convs if not c['grupo']]
        if args.apenas:
            convs = [c for c in convs if args.apenas.lower() in c['nome'].lower()]
        if not convs:
            sys.exit('Nenhuma conversa encontrada com esses filtros.')

        if args.listar:
            for c in convs:
                print(f'{c["total"]:>7}  {"grupo" if c["grupo"] else "     "}  {c["nome"]}')
            print(f'\n{len(convs)} conversas.')
            bd.con.close()
            backup.man.close()
            return

        saida = Path(args.saida)
        saida.mkdir(parents=True, exist_ok=True)
        try:
            for i, c in enumerate(convs, 1):
                destino, n_msg, n_midia, falt = exportar_conversa(bd, backup, c, saida, args.meu_nome, not args.sem_midia)
                extra = f', {n_midia} mídias' if n_midia else ''
                extra += f', {falt} indisponíveis' if falt else ''
                print(f'[{i}/{len(convs)}] {destino.name}: {n_msg} mensagens{extra}')
            print(f'\nPronto. Arquivos em: {saida.resolve()}')
        finally:
            bd.con.close()
            backup.man.close()


if __name__ == '__main__':
    main()
