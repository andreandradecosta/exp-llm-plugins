# pi-provider-exp

Pacote de extensão do [Pi](https://pi.dev/) para um gateway EXP compatível com
OpenAI Chat Completions. O provider é `exp` e os modelos aparecem como
`exp/<id>`.

A implementação usa o provider nativo do Pi (`createProvider`), reutiliza
`openAICompletionsApi` para serialização/streaming, ferramentas, uso e
cancelamento, e descobre o catálogo com `GET /models` e, opcionalmente,
`GET /model/info`.

## Instalação

O manifesto segue o formato atual de pacotes Pi e expõe `src/index.ts`.
Instalação local:

```bash
pi install /caminho/absoluto/para/pi
```

Após a publicação no npm, também poderá ser instalado por:

```bash
pi install npm:pi-provider-exp@1.0.0
```

Os pacotes `@earendil-works/pi-coding-agent` e
`@earendil-works/pi-ai` (inclusive o entrypoint `/compat`) são peers fornecidos
pelo próprio Pi; não são incluídos como dependências de runtime do pacote.

## Configuração global

A configuração é por usuário, no diretório retornado por `getAgentDir()` do Pi
(normalmente `~/.pi/agent`, ou o valor de `PI_CODING_AGENT_DIR`). Nada é salvo no
projeto.

1. Execute `/exp-configure` no Pi interativo.
2. Informe o endpoint, com ou sem `/v1` e com ou sem barras finais. Informe
   também o limite de saída padrão ou deixe o valor atual (inicialmente
   `16384`).
3. Execute `/login`, selecione o provider `exp` e digite o token no prompt
   **secreto**. O Pi salva a credencial em `~/.pi/agent/auth.json` com seu
   mecanismo nativo.

Em uma sessão interativa, salvar, trocar ou remover a credencial `exp` atualiza
o catálogo e o registro do provider automaticamente: não é necessário repetir
`/exp-configure`, recarregar a sessão ou escolher outro modelo. A extensão
observa o diretório de `auth.json` durante `session_start` para suportar escrita,
criação e rename, agrupa eventos por 100 ms, relê a credencial nativa e executa
uma única sequência segura de refreshes. O watcher, seus timers e uma descoberta
em andamento são encerrados em `session_shutdown`, inclusive durante `/reload`.
Falhas são notificadas sem incluir credenciais. Se `fs.watch` não estiver
disponível, a inicialização e os refreshes nativos continuam funcionando.

Nunca passe o token como argumento de `/exp-configure`, em comandos de shell,
no endpoint ou em arquivos de catálogo. O comando ignora argumentos e pede o
endpoint pela UI. Inicialização, modo headless e `--list-models` não abrem UI e
não iniciam watcher nem timers de sessão.

Arquivos usados por esta extensão:

- `exp-config.json`: endpoint normalizado, `defaultMaxTokens` e `timeoutMs`;
- `exp-models.json`: último catálogo EXP válido para fallback offline, sem
  token, headers ou credenciais;
- `auth.json`: credencial mantida exclusivamente pelo armazenamento nativo do
  Pi. A extensão apenas relê a entrada `exp` na descoberta antecipada e após
  mudanças de credencial detectadas na sessão interativa.

Também é possível revisar a configuração manualmente, por exemplo:

```json
{
  "baseUrl": "https://gateway.example.com/v1",
  "defaultMaxTokens": 16384,
  "timeoutMs": 5000
}
```

O timeout aceita valores entre 100 e 30000 ms. Não leia nem reutilize
`LITELLM_KEY`: a extensão não consulta essa variável nem outra credencial de
ambiente.

## Descoberta e metadados

Para um endpoint `https://gateway.example.com/v1`, a extensão chama em paralelo:

- `GET https://gateway.example.com/v1/models` (obrigatório e autoritativo);
- `GET https://gateway.example.com/v1/model/info` (opcional).

Ambos usam `Authorization: Bearer <token>` lido da credencial nativa. O corpo
de resposta e os headers de autenticação não são registrados em logs.

Somente IDs presentes em `/models` entram no catálogo. Assim, um modelo que
existe apenas em `/model/info` não é publicado. A ordem de `/models` é
preservada e IDs repetidos são deduplicados. A falha de `/model/info` não
impede o uso da lista principal.

Metadados aplicados:

- `id` e `name`: exatamente o ID de `/models`;
- `api`: `openai-completions`, preservando o suporte normal do Pi a tools para
  todos os modelos;
- `input`: `text` sempre; `image` somente quando
  `supports_vision === true`;
- `reasoning`: somente `true` quando `supports_reasoning === true`; nomes de
  modelos não são usados para inferir raciocínio;
- `contextWindow`: `max_input_tokens` de `/models`, depois o equivalente de
  `/model/info`, `max_tokens` de info ou, por fim, `128000`;
- `maxTokens`: `max_output_tokens` quando válido, senão `defaultMaxTokens`,
  limitado pelo tamanho do contexto;
- `cost`: zeros porque o gateway não informa preços. **Zero aqui significa
  custo desconhecido, não serviço gratuito nem preço real.**

`max_input_tokens` e limites equivalentes aceitam número ou string numérica.
A descoberta não altera o modelo padrão nem seleciona outro modelo.

## Inicialização, refresh e fallback

A fábrica assíncrona aguarda uma leitura do cache e, quando endpoint e token já
estão configurados, uma descoberta limitada por timeout antes de registrar o
provider. Isso disponibiliza os modelos na seleção inicial e em
`pi --list-models` sem deixar a inicialização indeterminada.

O mesmo provider implementa `refreshModels(context)` e publica pelo
`context.publish(...)` nativo, propagando `context.signal` ao HTTP. Atualizações
são substituições atômicas e protegidas por geração/cancelamento, portanto uma
atualização antiga não sobrescreve uma mais recente.

Em falha de rede, timeout, payload inválido ou erro HTTP, o último catálogo
válido continua em memória. Na primeira inicialização, o fallback vem de
`exp-models.json`; uma primeira falha sem cache é uma lista vazia e um erro
claro. Respostas 401/403 indicam explicitamente `/login`. Uma falha de cache
não impede uma nova leitura de rede. A persistência de refresh usa o storage
nativo do Pi e a descoberta antecipada persiste o fallback EXP separado.

## Desenvolvimento e testes

Requisitos validados: Node.js 24 e npm 11.

```bash
npm ci
npm test
npm run typecheck
npm run build
```

`npm test` executa contratos unitários com fetch, storage e credenciais
injetados: parsing e interseção, URL, visão/reasoning/tools, auth secreta,
cache, erros 401/403, timeout, cancelamento/concorrência, inicialização e
configuração global em diretórios temporários sob `.test-tmp/`. Não há acesso
a um gateway real nem escrita no `~/.pi/agent` verdadeiro durante os testes.

Para testar a entrada local manualmente, sem instalar globalmente:

```bash
pi -e /caminho/absoluto/para/pi/src/index.ts
```

Use um `PI_CODING_AGENT_DIR` apontado para um diretório temporário e um gateway mock
quando quiser isolar completamente esse teste manual. Os testes automatizados
não cobrem respostas de streaming de um servidor EXP real; essa parte depende
da compatibilidade efetiva do servidor com OpenAI Chat Completions, delegada
ao adaptador oficial do Pi.
