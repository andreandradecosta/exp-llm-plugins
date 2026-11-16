"""Descoberta e normalização do catálogo publicado pelo gateway."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Mapping

import httpx

DEFAULT_TIMEOUT = 3.0


class DiscoveryError(Exception):
    """Erro de descoberta seguro para exibição, sem dados de autenticação."""


@dataclass(frozen=True)
class RemoteModel:
    """Metadados mínimos necessários para construir um modelo do llm."""

    id: str
    max_input_tokens: int | None = None
    max_output_tokens: int | None = None
    supports_vision: bool = False

    def as_dict(self) -> dict[str, object]:
        """Retorna somente campos públicos e não sensíveis para o cache."""
        return {
            "id": self.id,
            "max_input_tokens": self.max_input_tokens,
            "max_output_tokens": self.max_output_tokens,
            "supports_vision": self.supports_vision,
        }

    @classmethod
    def from_dict(cls, value: object) -> RemoteModel | None:
        """Desserializa um item de cache, descartando entradas inválidas."""
        if not isinstance(value, Mapping):
            return None
        model_id = value.get("id")
        if not isinstance(model_id, str) or not model_id.strip():
            return None
        return cls(
            id=model_id.strip(),
            max_input_tokens=parse_token_limit(value.get("max_input_tokens")),
            max_output_tokens=parse_token_limit(value.get("max_output_tokens")),
            supports_vision=value.get("supports_vision") is True,
        )


def normalize_endpoint(endpoint: str) -> str:
    """Normaliza o endpoint para uma API OpenAI terminada exatamente em /v1."""
    base = endpoint.strip().rstrip("/")
    if not base:
        raise ValueError("O endpoint não pode ser vazio.")
    parsed = httpx.URL(base)
    if parsed.scheme not in ("http", "https") or not parsed.host:
        raise ValueError("O endpoint deve ser uma URL HTTP ou HTTPS válida.")
    if parsed.query or parsed.fragment:
        raise ValueError("O endpoint não deve conter query string ou fragmento.")
    if not base.endswith("/v1"):
        base = f"{base}/v1"
    return base


def parse_token_limit(value: object) -> int | None:
    """Converte limites numéricos ou strings positivas; ignora valores ruins."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, float):
        if not value.is_integer():
            return None
        value = int(value)
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _data_list(payload: object, endpoint_name: str) -> list[object]:
    if not isinstance(payload, Mapping) or not isinstance(payload.get("data"), list):
        raise DiscoveryError(
            f"Resposta inválida de {endpoint_name}: esperado objeto com lista 'data'."
        )
    data = payload["data"]
    assert isinstance(data, list)
    return data


def parse_models_payload(payload: object) -> list[RemoteModel]:
    """Lê /models, mantendo sua lista como a fonte autoritativa de IDs."""
    models: dict[str, RemoteModel] = {}
    for item in _data_list(payload, "/models"):
        if not isinstance(item, Mapping):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str) or not model_id.strip():
            continue
        model_id = model_id.strip()
        models[model_id] = RemoteModel(
            id=model_id,
            max_input_tokens=parse_token_limit(item.get("max_input_tokens")),
            max_output_tokens=parse_token_limit(item.get("max_output_tokens")),
        )
    return list(models.values())


def merge_model_info(
    models: list[RemoteModel], payload: object
) -> list[RemoteModel]:
    """Enriquece apenas IDs já presentes em /models com dados de /model/info."""
    info_by_id: dict[str, Mapping[str, object]] = {}
    for item in _data_list(payload, "/model/info"):
        if not isinstance(item, Mapping):
            continue
        model_id = item.get("model_name")
        model_info = item.get("model_info")
        if (
            isinstance(model_id, str)
            and model_id.strip()
            and isinstance(model_info, Mapping)
        ):
            info_by_id[model_id.strip()] = model_info

    enriched: list[RemoteModel] = []
    for model in models:
        model_info = info_by_id.get(model.id)
        if model_info is None:
            enriched.append(model)
            continue
        enriched.append(
            replace(
                model,
                max_input_tokens=(
                    model.max_input_tokens
                    if model.max_input_tokens is not None
                    else parse_token_limit(model_info.get("max_input_tokens"))
                ),
                max_output_tokens=(
                    model.max_output_tokens
                    if model.max_output_tokens is not None
                    else parse_token_limit(model_info.get("max_output_tokens"))
                ),
                supports_vision=model_info.get("supports_vision") is True,
            )
        )
    return enriched


def _get_json(client: httpx.Client, url: str, api_key: str) -> object:
    try:
        response = client.get(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status in (401, 403):
            raise DiscoveryError(
                f"Autenticação recusada pelo gateway (HTTP {status}). "
                "Execute 'llm exp configure' ou defina EXP_API_KEY."
            ) from None
        raise DiscoveryError(
            f"O gateway respondeu HTTP {status} ao consultar {url}."
        ) from None
    except httpx.RequestError as exc:
        raise DiscoveryError(
            f"Não foi possível consultar {url} ({type(exc).__name__})."
        ) from None
    try:
        return response.json()
    except ValueError:
        raise DiscoveryError(f"Resposta JSON inválida de {url}.") from None


def _fetch_with_client(
    client: httpx.Client, api_base: str, api_key: str
) -> list[RemoteModel]:
    models_payload = _get_json(client, f"{api_base}/models", api_key)
    models = parse_models_payload(models_payload)
    try:
        info_payload = _get_json(client, f"{api_base}/model/info", api_key)
        return merge_model_info(models, info_payload)
    except DiscoveryError:
        # /models já contém tudo que é indispensável; enrichments são opcionais.
        return models


def fetch_catalog(
    api_base: str,
    api_key: str,
    timeout: float = DEFAULT_TIMEOUT,
    client: httpx.Client | None = None,
) -> list[RemoteModel]:
    """Busca um catálogo novo; um cliente injetado facilita testes sem rede."""
    if client is not None:
        return _fetch_with_client(client, api_base, api_key)
    with httpx.Client(timeout=timeout, follow_redirects=False) as owned_client:
        return _fetch_with_client(owned_client, api_base, api_key)
