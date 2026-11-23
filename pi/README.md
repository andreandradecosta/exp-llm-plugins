# pi-llm-gateway

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
pi install npm:pi-llm-gateway@1.0.2
```

Os pacotes `@earendil-works/pi-coding-agent` e
`@earendil-works/pi-ai` (inclusive o entrypoint `/compat`) são peers fornecidos
pelo próprio Pi; não são incluídos como dependências de runtime do pacote.

## Primeiro uso: configurar, autenticar e listar modelos

Uma instalação limpa não faz descoberta: o endpoint do gateway é obrigatório e
deve ser informado explicitamente. Não há endpoint padrão, e nenhuma variável
de ambiente define ou substitui o endpoint configurado; `EXPLLM_HOST` não é
lida em nenhuma operação.

Depois de instalar o pacote:

1. Execute `/exp-configure` no Pi interativo e informe a URL do gateway, por
   exemplo `https://gateway.example.com`. A URL pode incluir ou omitir `/v1` e
   barras finais.
2. Execute `/login`, selecione o provider `exp` e digite o token no prompt
   **secreto**. Não use argumentos de shell, arquivos `.env` nem `EXPLLM_KEY`
   para informar o token.
3. A extensão descobre os modelos automaticamente. Eles ficam disponíveis como
   `exp/<id>` na seleção de modelos e em `pi --list-models`.

A ordem dos dois primeiros passos é livre, mas o catálogo só aparece quando o
endpoint estiver configurado e o token estiver salvo. O token é mantido
exclusivamente pelo `/login` nativo. A extensão não carrega arquivos `.env` e
não lê `EXPLLM_KEY`; definir essa variável não autentica o provider.

### Endpoint explícito

O endpoint informado por `/exp-configure` é normalizado internamente (o sufixo
`/v1` é garantido exatamente uma vez), persistido e reutilizado nas execuções
seguintes até ser substituído por um novo `/exp-configure`. A URL precisa ser
absoluta com HTTP ou HTTPS; credenciais na URL, query string e fragmento são
recusados.

Sem endpoint configurado, a extensão não faz descoberta HTTP nem restaura
cache: ela orienta a executar `/exp-configure` e, em sessões interativas,
notifica a falha na UI. Execuções sem UI, como `pi --list-models`, permanecem
silenciosas. Um endpoint salvo, porém inválido, produz erro de configuração
explícito: não há fallback silencioso para outro valor.

A configuração é por usuário, no diretório retornado por `getAgentDir()` do Pi
(normalmente `~/.pi/agent`, ou o valor de `PI_CODING_AGENT_DIR`). Nada é salvo
no projeto.

### Configuração avançada

Use `/exp-configure` para informar ou substituir o endpoint salvo e, ainda, o
limite de saída padrão (inicialmente `65536`). O comando é interativo: em
execuções sem UI ele recusa diálogos e orienta usar uma sessão interativa.

Em uma sessão interativa, salvar, trocar ou remover a credencial `exp` atualiza
o catálogo e o registro do provider automaticamente: não é necessário executar
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

- `exp-config.json`: arquivo com endpoint normalizado, `defaultMaxTokens` e
  `timeoutMs`;
- `exp-models.json`: último catálogo EXP válido para fallback offline, sem
  token, headers ou credenciais;
- `auth.json`: credencial mantida exclusivamente pelo armazenamento nativo do
  Pi. A extensão apenas relê a entrada `exp` na descoberta antecipada e após
  mudanças de credencial detectadas na sessão interativa.

Também é possível revisar a configuração manualmente, por exemplo:

```json
{
  "baseUrl": "https://gateway.example.com/v1",
  "defaultMaxTokens": 65536,
  "timeoutMs": 5000
}
```

O timeout aceita valores entre 100 e 30000 ms. A ausência de `baseUrl` mantém a
extensão sem endpoint configurado, como em uma instalação limpa.

## Descoberta e metadados

Para um endpoint `https://gateway.example.com/v1`, a extensão chama em paralelo:

- `GET https://gateway.example.com/v1/models` (obrigatório e autoritativo);
- `GET https://gateway.example.com/v1/model/info` (opcional).

Ambos usam `Authorization: Bearer <token>` lido da credencial nativa. O corpo
de resposta e os headers de autenticação não são registrados em logs, e
redirecionamentos são recusados para que o Bearer nunca seja reenviado a
outro destino.

Somente IDs presentes em `/models` entram no catálogo. Assim, um modelo que
existe apenas em `/model/info` não é publicado. A ordem de `/models` é
preservada e IDs repetidos são deduplicados. A falha de `/model/info` não
impede o uso da lista principal. Um `max_input_tokens` presente, porém
inválido (não numérico, zero ou negativo), rejeita a resposta inteira de
`/models` para evitar um catálogo com limites silenciosamente errados.

Metadados aplicados:

- `id` e `name`: exatamente o ID de `/models`;
- `api`: `openai-completions`, preservando o suporte normal do Pi a tools para
  todos os modelos;
- `input`: `text` sempre; `image` somente quando
  `supports_vision === true`;
- `reasoning`: sempre `true`, sem inferência pelo nome do modelo nem consulta a
  `supports_reasoning`;
- `compat.supportsDeveloperRole`: `false`, pois compatibilidade com OpenAI Chat
  Completions não garante suporte à role `developer`; as instruções usam `system`;
- `contextWindow`: `max_input_tokens` de `/models`, depois o equivalente de
  `/model/info`, `max_tokens` de info ou, por fim, `128000`;
- `maxTokens`: `max_output_tokens` quando válido, senão `defaultMaxTokens`
  (padrão `65536`), limitado pelo tamanho do contexto;
- `cost`: zeros porque o gateway não informa preços. **Zero aqui significa
  custo desconhecido, não serviço gratuito nem preço real.**

`max_input_tokens` e limites equivalentes aceitam número ou string numérica.
A descoberta não altera o modelo padrão nem seleciona outro modelo.

## Inicialização, refresh e fallback

A fábrica assíncrona aguarda uma leitura do cache e, quando o token nativo já
está disponível, uma descoberta no endpoint configurado limitada por timeout
antes de registrar o provider. Isso disponibiliza os modelos na seleção inicial
e em `pi --list-models`, sem exigir `/exp-configure` em cada execução nem
deixar a inicialização indeterminada.

O mesmo provider implementa `refreshModels(context)` e publica pelo
`context.publish(...)` nativo, propagando `context.signal` ao HTTP. Atualizações
são substituições atômicas e protegidas por geração/cancelamento, portanto uma
atualização antiga não sobrescreve uma mais recente.

Em falha de rede, timeout, payload inválido ou erro HTTP, o último catálogo
válido para o endpoint configurado continua em memória. Na primeira
inicialização, o fallback vem de `exp-models.json`; entradas cujo
`model.baseUrl` seja diferente do endpoint atual não são restauradas nem
apresentadas, inclusive após uma troca de endpoint por `/exp-configure`. Uma
primeira falha sem cache compatível resulta em lista vazia e erro claro.
Respostas 401/403 indicam explicitamente `/login`. Uma falha de cache não
impede uma nova leitura de rede. A persistência de refresh usa o storage nativo
do Pi e a descoberta antecipada persiste o fallback EXP separado.

## Desenvolvimento e testes

Requisitos validados: Node.js 24 e npm 11.

```bash
npm ci
npm test
npm run typecheck
npm run build
```

`npm test` executa contratos unitários com fetch, storage e credenciais
injetados: instalação limpa que exige endpoint sem descobrir nem restaurar
cache, normalização e ignoração de `EXPLLM_HOST`, ausência de autenticação por
`EXPLLM_KEY`, parsing e interseção, visão/reasoning/tools, auth secreta, cache
isolado por endpoint, erros 401/403, timeout, cancelamento/concorrência,
inicialização e configuração avançada em diretórios temporários sob
`.test-tmp/`. Um teste de contrato adicional executa o CLI real do Pi
(`--list-models`) contra um gateway mock local, em `HOME` isolado. Não há
acesso a um gateway real nem escrita no `~/.pi/agent` verdadeiro durante os
testes.

Para testar a entrada local manualmente, sem instalar globalmente:

```bash
pi -e /caminho/absoluto/para/pi/src/index.ts
```

Use um `PI_CODING_AGENT_DIR` apontado para um diretório temporário e um gateway mock
quando quiser isolar completamente esse teste manual. Os testes automatizados
não cobrem respostas de streaming de um servidor EXP real; essa parte depende
da compatibilidade efetiva do servidor com OpenAI Chat Completions, delegada
ao adaptador oficial do Pi.
