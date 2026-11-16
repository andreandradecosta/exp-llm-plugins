import json
import os
from pathlib import Path

import pytest

import llm_exp_gateway.storage as storage
from llm_exp_gateway.gateway import RemoteModel


def test_cache_atualiza_atomicamente_sem_arquivos_temporarios(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[Path, Path]] = []
    real_replace = os.replace

    def recording_replace(source: str | Path, destination: str | Path) -> None:
        calls.append((Path(source), Path(destination)))
        real_replace(source, destination)

    monkeypatch.setattr(storage.os, "replace", recording_replace)
    models = [
        RemoteModel(
            "Kimi-K3",
            max_input_tokens=262144,
            max_output_tokens=8192,
            supports_vision=True,
        )
    ]
    storage.save_cached_catalog("https://gateway.example.com/v1", models)

    assert len(calls) == 1
    source, destination = calls[0]
    assert source.parent == destination.parent
    assert destination == storage.cache_path()
    assert not source.exists()
    assert list(storage.cache_path().parent.glob("*.tmp")) == []
    assert storage.load_cached_catalog("https://gateway.example.com/v1") == models
    assert storage.load_cached_catalog("https://outro.example.com/v1") is None


def test_cache_corrompido_e_json_invalido_usam_fallback_seguro() -> None:
    path = storage.cache_path()
    path.parent.mkdir(parents=True)
    path.write_text("não é json", encoding="utf-8")
    assert storage.load_cached_catalog("https://gateway.example.com/v1") is None

    path.write_text(json.dumps({"api_base": "outro", "models": "inválido"}))
    assert storage.load_cached_catalog("https://gateway.example.com/v1") is None


def test_cache_nao_contem_campos_extras_nem_credenciais() -> None:
    token = "não-persistir"
    api_base = "https://gateway.example.com/v1"
    storage.save_cached_catalog(
        api_base, [RemoteModel("Kimi-K3", max_input_tokens=262144)]
    )
    raw_cache = storage.cache_path().read_text(encoding="utf-8")
    payload = json.loads(raw_cache)
    assert token not in raw_cache
    assert set(payload) == {"version", "api_base", "models"}
    assert set(payload["models"][0]) == {
        "id",
        "max_input_tokens",
        "max_output_tokens",
        "supports_vision",
    }


def test_endpoint_de_ambiente_e_opcional_e_tem_precedencia(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage.save_endpoint("https://arquivo.example.com/v1")
    assert storage.configured_endpoint() == "https://arquivo.example.com/v1"
    monkeypatch.setenv("EXP_LITELLM_HOST", "https://ambiente.example.com")
    assert storage.configured_endpoint() == "https://ambiente.example.com/v1"


def test_sem_configuracao_retorna_none() -> None:
    assert storage.configured_endpoint() is None
