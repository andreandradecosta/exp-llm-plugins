from pathlib import Path

import llm
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
    monkeypatch.delenv("EXP_LITELLM_HOST", raising=False)
    monkeypatch.delenv("EXP_DISCOVERY_TIMEOUT", raising=False)
    return user_path
