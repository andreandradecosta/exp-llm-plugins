from pathlib import Path

import llm
# Importado antes de qualquer monkeypatch: llm.cli faz `from llm import user_dir`
# e mantém essa referência para sempre. Sem isto, o primeiro import aconteceria
# durante um teste com `llm.user_dir` já parcheado e o `keys_set` nativo passaria
# a gravar no diretório temporário daquele teste nas execuções seguintes. Com o
# import antecipado, o binding é o da função original, que lê LLM_USER_PATH a
# cada chamada, como na execução real do CLI.
import llm.cli  # noqa: F401
import pytest


@pytest.fixture(autouse=True)
def isolated_llm_user_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """Impede que testes leiam ou alterem configuração real do usuário."""
    user_path = tmp_path / "llm-user"
    monkeypatch.setenv("LLM_USER_PATH", str(user_path))
    monkeypatch.setattr(llm, "user_dir", lambda: user_path)
    monkeypatch.delenv("EXP_API_KEY", raising=False)
    monkeypatch.delenv("EXPLLM_KEY", raising=False)
    monkeypatch.delenv("EXP_DISCOVERY_TIMEOUT", raising=False)
    return user_path
