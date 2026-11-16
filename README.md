# Plugins para harnesses

Plugins para que `OpenCode`, `pi.dev` e o CLI `llm` (Datasette) acessem os LLMs
internos expostos pelo gateway LiteLLM da EXP.

Cada harness possui um pacote independente, instalado e configurado por usuário.
O objetivo é que, após informar o endpoint e o token uma única vez, o usuário
encontre os modelos internos no seletor nativo do harness e tenha o catálogo
atualizado sempre que o harness for aberto.

## Pacotes

| Diretório | Harness | Documentação |
| --- | --- | --- |
| [`opencode/`](opencode/) | OpenCode V2 | [Instalação e uso](opencode/README.md) |
| [`pi/`](pi/) | Pi | [Instalação e uso](pi/README.md) |
| [`datasette-llm/`](datasette-llm/) | CLI `llm` | [Instalação e uso](datasette-llm/README.md) |

## Comportamento comum

Os três plugins seguem o mesmo contrato:

1. O usuário configura o endpoint do gateway e informa seu token em um fluxo
   interativo apropriado para o harness.
2. O plugin consulta `/v1/models` para obter os modelos disponíveis e, quando
   possível, usa `/v1/model/info` apenas para complementar seus metadados.
3. Os modelos são registrados no seletor nativo do harness com o provider `exp`.
4. O catálogo é atualizado a cada nova abertura ou inicialização do harness.
5. O último catálogo válido é preservado para permitir a abertura durante uma
   indisponibilidade temporária do gateway.

A configuração é global por usuário. Tokens são mantidos pelo mecanismo de
credenciais do próprio harness e nunca no repositório, no catálogo em cache ou
nos logs. O plugin não altera automaticamente o modelo padrão escolhido pelo
usuário.

Todos os modelos retornados por `/v1/models` são registrados com suporte a
ferramentas. Modelos presentes somente em `/v1/model/info` não são adicionados.
Os demais metadados são tratados de forma conservadora quando o gateway não os
fornece.

## Gateway

O endpoint informado pode conter ou não o sufixo `/v1`. A autenticação usa
`Authorization: Bearer <token>`, e a inferência utiliza a API OpenAI Chat
Completions.

Exemplo de endpoint:

```text
http://pgeodsv1.ep.petrobras.com.br:4001
```

## Desenvolvimento

Cada pacote documenta seus próprios comandos de instalação local, testes e
verificação de tipos. Para testes manuais com o gateway, o repositório aceita um
arquivo `.env` local, não versionado, com:

```dotenv
LITELLM_HOST=http://pgeodsv1.ep.petrobras.com.br:4001
LITELLM_KEY=seu-token
```

Nenhum teste automatizado de unidade utiliza essas credenciais ou depende do
gateway real. A validação integrada deve confirmar descoberta, streaming e
chamada de ferramenta em cada harness.

Para o desenvolvimento Python, utilize o ambiente virtual `.venv` na raiz do
repositório, criado e atualizado com `uv`.
