"""Configuração pública e cache global, ambos sem credenciais."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import llm

from .gateway import RemoteModel, normalize_endpoint

CONFIG_FILENAME = "exp-gateway.json"
CACHE_FILENAME = "exp-gateway-models.json"
ENV_ENDPOINT = "EXPLLM_HOST"
DEFAULT_ENDPOINT = "http://pgeodsv1.ep.petrobras.com.br:4001/v1"


class ConfigurationError(Exception):
    """Configuração ou cache local ilegível."""


def config_path() -> Path:
    return llm.user_dir() / CONFIG_FILENAME


def cache_path() -> Path:
    return llm.user_dir() / CACHE_FILENAME


def _write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    """Grava em arquivo irmão e usa rename atômico para evitar cache parcial."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary_path.chmod(0o600)
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def save_endpoint(api_base: str) -> None:
    """Persiste apenas o endpoint normalizado, nunca o token."""
    _write_json_atomic(config_path(), {"version": 1, "api_base": api_base})


def configured_endpoint() -> str:
    """Resolve o endpoint por ambiente, configuração persistida ou padrão."""
    environment_value = os.environ.get(ENV_ENDPOINT, "").strip()
    if environment_value:
        try:
            return normalize_endpoint(environment_value)
        except ValueError as exc:
            raise ConfigurationError(f"{ENV_ENDPOINT} inválido: {exc}") from None
    path = config_path()
    if not path.exists():
        return DEFAULT_ENDPOINT
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigurationError(
            f"Não foi possível ler {path}; execute 'llm exp configure'."
        ) from None
    if not isinstance(payload, dict) or not isinstance(payload.get("api_base"), str):
        raise ConfigurationError(
            f"Configuração inválida em {path}; execute 'llm exp configure'."
        )
    try:
        return normalize_endpoint(payload["api_base"])
    except ValueError as exc:
        raise ConfigurationError(str(exc)) from None


def load_cached_catalog(api_base: str) -> list[RemoteModel] | None:
    """Carrega o último catálogo válido somente se pertencer ao mesmo endpoint."""
    path = cache_path()
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(payload, dict)
            or payload.get("api_base") != api_base
            or not isinstance(payload.get("models"), list)
        ):
            return None
        models = [
            model
            for item in payload["models"]
            if (model := RemoteModel.from_dict(item)) is not None
        ]
    except (OSError, json.JSONDecodeError, TypeError):
        return None
    # Elimina duplicatas acidentais de caches antigos sem reintroduzir IDs stale.
    return list({model.id: model for model in models}.values())


def save_cached_catalog(api_base: str, models: list[RemoteModel]) -> None:
    """Substitui atomicamente todo o catálogo anterior por um snapshot válido."""
    _write_json_atomic(
        cache_path(),
        {
            "version": 1,
            "api_base": api_base,
            "models": [model.as_dict() for model in models],
        },
    )
