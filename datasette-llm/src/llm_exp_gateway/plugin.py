"""Integração do gateway com os hooks e comandos do LLM."""

from __future__ import annotations

import os
from collections.abc import Callable

import click
import llm
from llm.default_plugins.openai_models import AsyncChat, Chat

from .gateway import (
    DEFAULT_TIMEOUT,
    DiscoveryError,
    RemoteModel,
    fetch_catalog,
    normalize_endpoint,
)
from .storage import (
    ConfigurationError,
    configured_endpoint,
    load_cached_catalog,
    save_cached_catalog,
    save_endpoint,
)

KEY_ALIAS = "exp"
KEY_ENV_VAR = "EXP_API_KEY"
MODEL_PREFIX = "exp/"
TIMEOUT_ENV_VAR = "EXP_DISCOVERY_TIMEOUT"
Register = Callable[..., None]


def _warn(message: str) -> None:
    click.echo(f"exp-gateway: {message}", err=True)


def _discovery_timeout() -> float:
    raw_value = os.environ.get(TIMEOUT_ENV_VAR)
    if raw_value is None:
        return DEFAULT_TIMEOUT
    try:
        timeout = float(raw_value)
    except ValueError:
        return DEFAULT_TIMEOUT
    return timeout if timeout > 0 else DEFAULT_TIMEOUT


def _build_model_pair(
    model: RemoteModel, api_base: str
) -> tuple[Chat, AsyncChat]:
    """Cria modelos nativos sem reimplementar inferência nem streaming."""
    model_id = f"{MODEL_PREFIX}{model.id}"
    common = {
        "model_id": model_id,
        "model_name": model.id,
        "api_base": api_base,
        "can_stream": True,
        "vision": model.supports_vision,
        "supports_tools": True,
    }
    sync_model = Chat(**common)
    async_model = AsyncChat(**common)
    for instance in (sync_model, async_model):
        # Instâncias customizadas não devem herdar a chave padrão da OpenAI.
        instance.needs_key = KEY_ALIAS
        instance.key_env_var = KEY_ENV_VAR
        instance.default_max_tokens = model.max_output_tokens
        # O llm ainda não valida contexto de entrada, mas expõe o metadado.
        instance.max_input_tokens = model.max_input_tokens
        instance.max_output_tokens = model.max_output_tokens
    return sync_model, async_model


def _register_catalog(
    models: list[RemoteModel], api_base: str, register: Register
) -> None:
    for model in models:
        sync_model, async_model = _build_model_pair(model, api_base)
        register(sync_model, async_model)


@llm.hookimpl
def register_models(register: Register) -> None:
    """Atualiza o catálogo em cada invocação e usa cache somente como fallback."""
    try:
        api_base = configured_endpoint()
    except (ConfigurationError, ValueError) as exc:
        _warn(str(exc))
        return
    cached = load_cached_catalog(api_base)
    try:
        api_key = llm.get_key(key_alias=KEY_ALIAS, env_var=KEY_ENV_VAR)
    except (OSError, ValueError):
        api_key = None
    if not api_key:
        _warn(
            "token não configurado; execute 'llm exp configure' ou defina "
            f"{KEY_ENV_VAR}."
        )
        _register_catalog(cached or [], api_base, register)
        return

    try:
        models = fetch_catalog(api_base, api_key, timeout=_discovery_timeout())
    except DiscoveryError as exc:
        if cached is None:
            _warn(f"{exc} Nenhum catálogo em cache está disponível.")
        else:
            _warn(f"{exc} Usando o último catálogo válido em cache.")
        _register_catalog(cached or [], api_base, register)
        return

    try:
        save_cached_catalog(api_base, models)
    except OSError:
        _warn("não foi possível atualizar o cache; usando o catálogo recém-obtido.")
    _register_catalog(models, api_base, register)


def _store_api_key(token: str) -> None:
    """Usa a implementação nativa de `llm keys set`, sem shell ou argv secreto."""
    from llm.cli import keys_set

    callback = keys_set.callback
    if callback is None:
        raise OSError(
            "O mecanismo nativo de chaves do llm não está disponível."
        )
    callback(KEY_ALIAS, token)


@click.group(name="exp")
def exp() -> None:
    """Configura a integração com o gateway EXP."""


@exp.command(name="configure")
def configure() -> None:
    """Solicita o token sem exibi-lo e o endpoint obrigatório do gateway."""
    token = click.prompt("Token da API", hide_input=True, type=str)
    if not token:
        raise click.ClickException("O token não pode ser vazio.")
    endpoint = click.prompt("Endpoint do gateway", type=str)
    try:
        api_base = normalize_endpoint(endpoint)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from None
    try:
        _store_api_key(token)
    except OSError as exc:
        raise click.ClickException(
            f"Não foi possível salvar o token no mecanismo nativo de chaves "
            f"do llm: {type(exc).__name__}."
        ) from None
    try:
        save_endpoint(api_base)
    except OSError as exc:
        raise click.ClickException(
            f"Não foi possível salvar o endpoint: {type(exc).__name__}. "
            "O token já foi salvo; execute o comando novamente."
        ) from None
    click.echo(
        "Gateway configurado. O token foi armazenado no mecanismo nativo de "
        "chaves do llm com o nome 'exp'."
    )


@llm.hookimpl
def register_commands(cli: click.Group) -> None:
    """Registra `llm exp configure` sem executar descoberta."""
    cli.add_command(exp)
