# Extrair conversas do backup do iPhone

Gera um `.zip` por conversa (mesmo formato da exportação do WhatsApp) a partir de um
backup **sem criptografia** do iPhone feito no Windows. Tudo roda no seu computador.

## Passo a passo
1. Conecte o iPhone ao PC e faça um backup no app **Dispositivos Apple** (ou iTunes),
   escolhendo **Este computador** e **deixando "Criptografar backup local" desmarcado**.
2. Instale o Python 3.9 ou mais novo (https://www.python.org/downloads/).
3. Veja as conversas encontradas:
   ```
   python extrair_backup_iphone.py --listar
   ```
4. Exporte tudo (ou só algumas):
   ```
   python extrair_backup_iphone.py --saida C:\Users\voce\Desktop\conversas --meu-nome "Seu Nome"
   python extrair_backup_iphone.py --apenas "Maria" --saida conversas
   python extrair_backup_iphone.py --sem-grupos --sem-midia
   ```
5. No app, **Conversas → Importar conversa do WhatsApp**, selecione todos os `.zip` gerados.
6. **Apague o backup** e/ou os `.zip` do PC quando terminar, se não precisar mais deles.

## Opções
| Opção | O que faz |
|---|---|
| `--backup PASTA` | Usa um backup específico (padrão: o mais recente) |
| `--saida PASTA` | Onde gravar os `.zip` |
| `--listar` | Só lista as conversas |
| `--apenas TEXTO` | Só conversas cujo nome contém o texto |
| `--sem-grupos` | Ignora grupos |
| `--sem-midia` | Não copia fotos, vídeos, áudios e documentos |
| `--meu-nome NOME` | Nome que aparece nas suas mensagens (padrão: Eu) |

## Limites
- Não lê backups criptografados.
- Mídias que o iPhone não baixou ou apagou não estão no backup e aparecem como
  `<mídia não disponível: …>`.
- O formato do banco do WhatsApp muda entre versões; se algo sair errado, o erro mostra a tabela
  ou coluna que não foi encontrada.
