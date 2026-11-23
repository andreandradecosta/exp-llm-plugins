# opencode-llm-gateway

Plugin **OpenCode V2** para descobrir e usar modelos de um gateway compatível
com a API OpenAI. O provider é registrado como `exp`; os modelos aparecem como
`exp/<id>` no seletor `/models`.

A implementação usa as APIs atuais de server, TUI e RPC de
`@opencode/plugin` (`2.3.0`). Não há API V1, leitura de `.env` ou acesso
direto ao banco de credenciais. A variável `EXPLLM_KEY`, usada somente em
validações manuais de desenvolvimento, não é consultada pelo plugin.

## Instalação global

Depois de publicar este pacote no npm, instale-o globalmente pela CLI do
OpenCode:

```sh
opencode plugin add opencode-llm-gateway@1.0.0
opencode plugin list
```

Um pacote com partes server e TUI deve ser instalado em `opencode.json(c)` pela
CLI acima; não é necessário adicioná-lo separadamente a `cli.json`. A instalação
global disponibiliza o provider nos projetos abertos pelo mesmo usuário.

Para desenvolvimento local, execute `npm run build` e referencie o diretório em
`opencode.json(c)`. Nenhum comando abaixo altera a configuração automaticamente:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/caminho/absoluto/para/opencode-llm-gateway",
      "options": {
        "fallbackContextTokens": 128000,
        "fallbackOutputTokens": 16384,
        "requestTimeoutMs": 15000
      }
    }
  ]
}
```

O target testado é OpenCode V2 com `@opencode/plugin` 2.3.0. Atualizações do
host devem ser acompanhadas por typecheck e testes de instalação do pacote.

## Configuração e autenticação

Antes da primeira descoberta, é obrigatório informar explicitamente o endpoint.
O plugin não tem endpoint padrão nem obtém essa configuração de variáveis de
ambiente. Abra o OpenCode e execute:

```text
/exp-setup
```

Informe a URL do gateway no prompt interativo, por exemplo
`https://gateway.example.com`. O endpoint normalizado é persistido em
`ctx.storage` e reutilizado nas execuções seguintes até ser substituído por um
novo `/exp-setup`. Também são aceitos endpoints com `/v1`, barras finais e
caminhos-base adicionais. A URL precisa ser absoluta e usar HTTP ou HTTPS.
Credenciais na URL, query strings e fragmentos são recusados.

Sem endpoint configurado, o plugin não faz descoberta HTTP nem publica modelos.
`/exp-refresh`, `/exp-status` e a atualização automática do TUI orientam o
usuário a executar `/exp-setup`.

Depois de configurar o endpoint, execute somente o fluxo nativo de autenticação:

```text
/connect
```

Selecione **Gateway EXP**, o método **Token do gateway**
e informe o token no prompt nativo. O token não é aceito na configuração do
plugin e não deve ser digitado no histórico de comandos, variáveis de ambiente
ou prompts de sessão.

Finalize em `/models`, escolhendo um modelo `exp/<id>`. O plugin não altera o
modelo default selecionado pelo usuário.

Comandos disponíveis:

- `/exp-setup`: informa ou substitui o endpoint persistido; não aceita token.
- `/exp-refresh`: força uma atualização do catálogo.
- `/exp-status`: mostra endpoint, estado da conexão, data do cache, metadados e
  a última falha segura, sem mostrar o token.

O TUI chama o RPC de refresh ao abrir, pois o server compartilhado pode continuar
ativo entre sessões do TUI. Ao concluir o RPC, ele invalida e sincroniza os dados
de modelos, providers e integrações, portanto `/models` reflete o novo catálogo
sem exigir `opencode service restart`. A inicialização do server também solicita
a atualização do catálogo. Eventos nativos `credential.updated` e
`credential.switched` fazem novas descobertas após login, troca ou remoção da
conta, desde que o endpoint esteja configurado.

## Descoberta e metadados

Com o Bearer da credencial nativa ativa, o server consulta, apenas para
**descoberta**, com as duas requisições em paralelo:

1. `GET {baseURL}/models` — obrigatório e fonte autoritativa dos IDs;
2. `GET {baseURL}/model/info` — enriquecimento opcional.

Nenhuma inferência é feita nessa camada. As requisições reais de inferência são
executadas pelo OpenCode com o package nativo:

```text
@opencode/ai/providers/openai-compatible
```

O provider contém somente `integrationID`, `settings.baseURL` e metadados públicos
dos modelos. Durante a inferência, o próprio host resolve a conexão dessa
integração e aplica sua credencial Bearer. O segredo não é copiado para headers,
modelos, catálogos ou cache.

Regras de conversão:

- somente IDs presentes em `/models` entram; entradas exclusivas de `model/info`
  são ignoradas;
- IDs duplicados são publicados uma única vez;
- `max_input_tokens` aceita número ou string inteira positiva; o valor de
  `/models` tem precedência sobre o de `model/info`;
- `limit.context` usa esse limite de entrada, depois `max_tokens` de
  `model/info`; se todos omitirem o valor, aplica `fallbackContextTokens`
  (default: **128000**);
- `limit.output` usa somente `max_output_tokens` e, por fim,
  `fallbackOutputTokens` (default: **16384**). O campo total `max_tokens` nunca é
  tratado como limite de saída;
- todos os modelos de `/models` recebem `capabilities.tools = true`, por regra de
  negócio do gateway;
- entrada de imagem é habilitada somente quando `supports_vision === true`.
  Ausência, `false` ou strings como `"true"` resultam em modelo somente texto;
- custos não são inventados e a data `created`, quando numérica, é convertida de
  segundos para milissegundos;
- não se infere reasoning nem variantes pelo nome do modelo. O adaptador nativo
  OpenAI Chat reconhece campos como `reasoning_content` quando o gateway os envia;
  isso não declara que todos os modelos suportam raciocínio.

Uma falha ou resposta inválida de `model/info` não bloqueia `/models`. Nesse caso
os fallbacks são usados, visão permanece desabilitada salvo confirmação explícita
em um payload válido e `/exp-status` apresenta um aviso. Falhas 401/403 incluem a
orientação para autenticar novamente por `/connect`.

## Persistência, cache e concorrência

O endpoint informado por `/exp-setup` e o último catálogo válido são persistidos
em `ctx.storage`, sem segredos. O token fica no mecanismo nativo de contas do
OpenCode (SQLite no server V2), gerenciado por `/connect`.

Cada catálogo fica associado ao endpoint e à identidade não secreta da conexão
que o descobriu. A definição do provider usa `sourceConnection`, impedindo que
o inventário de uma conta seja apresentado após troca ou desconexão. O cache em
disco dessa conta anterior só volta a ser usado para a mesma combinação de
endpoint e conexão autenticada.

- Um refresh válido substitui o catálogo inteiro, eliminando IDs obsoletos e
  duplicados. A publicação no provider ocorre apenas depois da persistência do
  novo snapshot.
- Refreshs concorrentes na mesma revisão compartilham uma única descoberta.
- Se endpoint ou conexão mudarem durante uma descoberta, uma atualização posterior
  é enfileirada. As requisições não se sobrepõem e uma resposta antiga (stale) é
  descartada.
- Falha de `/models`, rede, timeout ou resposta inválida mantém o último catálogo
  válido para a conexão atual. Na primeira falha, quando ainda não há cache,
  `/exp-status` informa explicitamente que nenhum catálogo está disponível.
- Cada chamada HTTP tem timeout próprio (`requestTimeoutMs`, default: **15000 ms**),
  inclusive durante a leitura do corpo. As duas chamadas são feitas em paralelo,
  portanto um refresh com falha leva no máximo um timeout.

Erros não incluem corpo de resposta, header Authorization, token ou payload
sensível. O plugin também não escreve esses dados em logs.

## Desenvolvimento e testes

Requisitos: Node.js 24 e npm 11 (ambiente usado: Node 24.16.0, npm 11.13.0).

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

O runner usa `node:test` com o type stripping nativo do Node 24. O build gera ESM
JavaScript e declarações em `dist/`, exportados como:

- `.`: plugin server;
- `./tui`: comandos do TUI;
- `./rpc`: contrato RPC portável.

Os arquivos principais são:

- `src/index.ts`: setup V2, integração nativa, provider, RPC e eventos;
- `src/service.ts`: estado, cache, single-flight, fila de refresh e atomicidade;
- `src/gateway.ts`: HTTP autenticado, timeouts e erros seguros;
- `src/catalog.ts`: parsing, interseção, deduplicação e limites;
- `src/endpoint.ts`: normalização e validação do endpoint;
- `src/rpc.ts`: schema RPC e status;
- `src/tui.ts`: `/exp-setup`, `/exp-refresh` e `/exp-status`;
- `test/`: testes unitários e de contrato HTTP com mocks.

Nenhum teste unitário chama o gateway real. Adicionalmente, o pacote foi
validado localmente com OpenCode 2.3.0 em HOME isolado: ativação server/RPC,
conexão nativa por API, descoberta dos 9 modelos, configuração compartilhada por
dois projetos, inferência real e chamada da ferramenta `read`. Os comandos TUI
foram verificados por typecheck; antes da publicação, convém também exercitar o
fluxo visual `/exp-setup`, `/connect` e `/models` na interface de destino.
