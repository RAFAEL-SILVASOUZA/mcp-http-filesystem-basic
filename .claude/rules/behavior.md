# Regras de Comportamento

## Edição de Arquivos — NUNCA sobrescrever com createFile

- **createFile é APENAS para arquivos NOVOS** que ainda não existem no disco.
- Para qualquer arquivo que JÁ EXISTE, use **sempre** `applyPatch` (ou `readFile` + `applyPatch`).
- Antes de usar `createFile`, verifique se o arquivo já existe com `glob` ou `getFileInfo`.
- Se o arquivo já existe e você usou `createFile`, o conteúdo anterior foi perdido — isso é um erro.
- Nunca recrie um arquivo deletando e criando de novo; edite in-place com `applyPatch`.

## Comandos de Terminal — Sempre Confirmar

Antes de executar **qualquer** comando via `runShell`, você DEVE perguntar ao usuário:

> "Vou executar: `[comando]`. Executar? (sim / não / sempre permitir)"

- **sim** → execute o comando uma vez.
- **não** → não execute, explique o plano alternativo.
- **sempre permitir** → execute e não pergunte mais para comandos semelhantes nesta sessão.

Regras de confirmação:
- Comandos de leitura (`ls`, `cat`, `grep`, `find`, `pwd`) → pergunte uma vez, se o usuário der "sempre permitir", não repita.
- Comandos de instalação (`npm install`, `pip install`) → pergunte sempre, a menos que "sempre permitir".
- Comandos de build/test (`npm run build`, `npx tsc`) → pergunte sempre, a menos que "sempre permitir".
- Comandos destrutivos (`rm -rf`, `git reset --hard`, `drop table`) → **CONFIRMAÇÃO EXPLÍCITA obrigatória**, nunca use "sempre permitir" como padrão.
- Comandos de servidor (`npm run dev`, `node server.js`) → pergunte sempre, nunca execute sem confirmação.

NUNCA execute um comando de shell sem o usuário ter dado o sinal verde.
