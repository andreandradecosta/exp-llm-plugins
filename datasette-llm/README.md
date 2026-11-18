# llm-llm-gateway

Plugin para o [CLI `llm`](https://llm.datasette.io/) de Simon Willison que
descobre modelos publicados por um gateway LiteLLM compatível com a API OpenAI.
Apesar do nome do diretório de trabalho, este projeto é um plugin para o CLI
`llm`, não uma aplicação web nem um plugin Datasette.

A inferência, o streaming, as ferramentas e os clientes síncrono e assíncrono
são fornecidos pelas classes nativas `Chat` e `AsyncChat` do próprio `llm`. Os
IDs locais recebem o prefixo `exp/`, enquanto a requisição upstream conserva o
ID original. Assim, `exp/Kimi-K3` chama o modelo `Kimi-K3` no gateway.

## Instalação

No ambiente em que o `llm` está instalado:

```bash
llm install llm-llm-gateway
```

Para uma cópia local em desenvolvimento:

```bash
llm install -e /caminho/para/datasette-llm
```

O pacote registra o entry point `llm` durante a instalação; não é necessário
editar configuração do `llm` para habilitá-lo.

## Configuração interativa

Não há endpoint padrão nem configuração de endpoint por variável de ambiente.
Execute:

```bash
llm exp configure
```

O comando solicita o **token**, com entrada oculta, e o **endpoint do gateway**,
que é obrigatório. O token é salvo com o nome `exp` pelo mesmo mecanismo usado
por `llm keys set exp`; ele não é argumento de shell e, portanto, não entra no
histórico de comandos nem é exibido pelo plugin. O endpoint pode ser informado
com ou sem `/v1` e com ou sem barra final, e é persistido normalizado para
`/v1`. O arquivo de configuração contém somente esse metadado público, nunca o
token.

Sem um endpoint salvo, o plugin não faz descoberta HTTP e orienta a executar
`llm exp configure`, sem interromper os demais comandos do `llm`.

Também é possível usar as variáveis de ambiente:

- `EXP_API_KEY`: token, como alternativa ao armazenamento nativo de chaves;
- `EXP_DISCOVERY_TIMEOUT`: timeout em segundos de cada consulta HTTP (padrão
  `3.0`; valores inválidos ou não positivos voltam ao padrão).

A configuração e o catálogo ficam no diretório global retornado por
`llm.user_dir()`:

- `exp-gateway.json`: somente versão e endpoint efetivo normalizado;
- `exp-gateway-models.json`: último catálogo válido, sem token ou cabeçalhos;
- `keys.json`: credencial administrada exclusivamente pelo mecanismo nativo
  do `llm`, não pelo arquivo de configuração deste plugin.

`llm exp configure` não faz descoberta e funciona ainda que não exista uma
configuração anterior.

## Uso

Atualize e liste os modelos:

```bash
llm models
llm models --tools
```

Execute um prompt pontual:

```bash
llm -m exp/Kimi-K3 "Explique testes de contrato em três tópicos"
```

Ou inicie uma conversa contínua:

```bash
llm chat -m exp/Kimi-K3
```

Há suporte nativo a streaming e a ferramentas para todo ID anunciado por
`/models`. Modelos com `supports_vision: true` em `/model/info` também aceitam
anexos compatíveis, por exemplo:

```bash
llm -m exp/Kimi-K3 "Descreva esta imagem" -a imagem.png
```

## Descoberta, metadados e fallback

A cada invocação do hook de modelos em um processo, o plugin consulta:

1. `GET {endpoint}/models`, com `Authorization: Bearer ...`;
2. `GET {endpoint}/model/info`, opcionalmente, para enriquecer os metadados.

A lista de `/models` é autoritativa. Um modelo presente somente em
`/model/info` nunca é registrado. Falha, timeout ou JSON inválido no segundo
endpoint não impede o uso da lista principal. Respostas HTTP 401 e 403 da
lista principal produzem orientação explícita para revisar a autenticação; o
corpo da resposta e o token não são expostos em mensagens.

`max_input_tokens` aceita número ou string. Quando disponível,
`max_output_tokens` é usado como limite padrão de saída do `Chat` nativo. Não há
limite inventado na ausência do metadado. Visão depende exclusivamente de
`supports_vision: true`; não se infere `reasoning` nem visão pelo nome do
modelo. Respostas continuam sendo processadas pelas implementações nativas do
`llm`, inclusive os metadados que elas já preservam.

O catálogo válido substitui integralmente o cache por escrita temporária e
rename atômico, evitando IDs obsoletos ou duplicados. O isolamento por endpoint
impede reutilizar o catálogo de outro gateway. Se a renovação falhar, o último
catálogo válido do mesmo endpoint é usado temporariamente e uma mensagem clara
é emitida no stderr. Na primeira falha, sem cache, o plugin não interrompe os
demais comandos do `llm`. Sem endpoint salvo, nenhuma requisição é feita. Com
endpoint salvo, mas sem token no mecanismo nativo de chaves ou em
`EXP_API_KEY`, também não há requisição e só pode haver fallback ao cache
público do mesmo endpoint.

## Desenvolvimento e testes

A partir da raiz deste repositório, usando o virtualenv `.venv` da raiz:

```bash
uv venv .venv
uv pip install --python .venv/bin/python -e './datasette-llm[dev]'
.venv/bin/python -m pytest datasette-llm/tests -p no:cacheprovider
```

O plugin não carrega arquivos `.env` nem consulta `EXPLLM_KEY` em runtime. Essa
variável é reservada exclusivamente para validação manual de desenvolvimento;
não é uma alternativa ao mecanismo nativo de chaves ou a `EXP_API_KEY`.

Os testes usam `httpx.MockTransport`, mocks e diretórios temporários isolados
para `llm.user_dir()`/`LLM_USER_PATH`. Eles não acessam o gateway real, não
leem a configuração pessoal e não deixam tokens de teste fora dos diretórios
temporários. A distribuição também foi validada com `uv build` e, em
`LLM_USER_PATH` isolado, com o gateway real: descoberta dos 9 modelos,
inferências síncrona e assíncrona e execução de uma ferramenta pelo modelo.

Na versão atual do gateway, o campo não padrão `metadata` das respostas pode ser
uma lista, enquanto o SDK OpenAI espera outro formato. Algumas versões do
SDK/Pydantic emitem um `UserWarning` ao serializá-lo para os logs do `llm`.
Esse aviso é originado pela conversão nativa do SDK, não contém o token e não
impediu as respostas ou as ferramentas na validação real.
