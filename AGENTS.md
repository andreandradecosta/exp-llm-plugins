# AGENTS.md


## Diretivas:
- Usar virtual environment local: `.venv`.
- Usar ferramenta `uv` para criar e atualizar virtual environment.
- Use a skill `read-arxiv-paper` para ler papers publicados no site `arxiv.org`.
- Use type hints para parâmetros de entrada e retorno de funções.
- Quando for solicitado um `research`, faça pesquisas em fóruns, reddit, publicações sobre o tema.
- Só realizar o commit quando solicitado de forma explícita.

## Desenvolvimento e validação

Os pacotes são independentes e seus testes unitários não acessam o gateway real:

```bash
cd opencode && npm ci && npm test && npm run typecheck && npm run build
cd pi && npm ci && npm test && npm run typecheck && npm run build

uv venv .venv
uv pip install --python .venv/bin/python -e './datasette-llm[dev]'
.venv/bin/python -m pytest datasette-llm/tests -p no:cacheprovider
uv build ./datasette-llm --out-dir /tmp/opencode/llm-exp-dist
```

Validações com `EXPLLM_HOST` e `EXPLLM_KEY` do `.env` devem usar diretórios
temporários e configuração/credenciais isoladas das configurações pessoais.
Nunca imprimir ou salvar tokens em logs, fixtures, caches e exemplos.

## Regras de commit

Ao escrever uma mensagem de commit, siga estas 7 regras:
- Regra 1: Separe a linha de assunto do corpo com uma única linha em branco.
- Regra 2: Limite a linha de assunto a 50 caracteres (72 é o limite máximo absoluto).
- Regra 3: Capitalize a primeira letra da linha de assunto.
- Regra 4: Não termine a linha de assunto com um ponto.
- Regra 5: Use o modo imperativo na linha de assunto (por exemplo, "Corrigir bug,"
          "Adicionar funcionalidade," e não "Corrigido" ou "Adiciona"). Fórmula de teste:
          deve completar a frase: "Se aplicado, este commit irá [sua linha de assunto aqui]".
- Regra 6: Quebre o texto do corpo manualmente em 72 caracteres para evitar problemas
          de formatação do Git.
- Regra 7: Use o corpo para explicar o quê e o porquê, e não o como. Considere que o
          código explica o como; a mensagem deve explicar o contexto e o raciocínio.