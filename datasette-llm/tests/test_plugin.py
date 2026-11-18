import json
from collections.abc import Callable
from pathlib import Path

import click
import llm
import pytest
from click.testing import CliRunner
from llm.default_plugins.openai_models import AsyncChat, Chat

import llm_exp_gateway.plugin as plugin
from llm_exp_gateway.gateway import DiscoveryError, RemoteModel
from llm_exp_gateway.storage import (
    cache_path,
    config_path,
    save_cached_catalog,
    save_endpoint,
)

Registrations = list[tuple[Chat, AsyncChat | None]]


def collect_registrations(registrations: Registrations) -> Callable[..., None]:
    def register(sync_model: Chat, async_model: AsyncChat | None = None) -> None:
        registrations.append((sync_model, async_model))

    return register


def test_hook_sem_configuracao_nao_faz_rede(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("EXPLLM_KEY", "chave-manual-nao-deve-ser-lida")

    def unexpected_fetch(*args: object, **kwargs: object) -> list[RemoteModel]:
        raise AssertionError("rede não deveria ser chamada sem endpoint salvo")

    monkeypatch.setattr(plugin, "fetch_catalog", unexpected_fetch)
    registrations: Registrations = []
    plugin.register_models(collect_registrations(registrations))
    assert registrations == []
    captured = capsys.readouterr()
    assert "endpoint não configurado" in captured.err
    assert "llm exp configure" in captured.err
    assert "chave-manual-nao-deve-ser-lida" not in captured.err + captured.out
    assert not config_path().exists()


def test_hook_sem_configuracao_com_token_nativo_nao_faz_discovery(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(plugin.llm, "get_key", lambda **kwargs: "segredo-nativo")

    def unexpected_fetch(*args: object, **kwargs: object) -> list[RemoteModel]:
        raise AssertionError("token sem endpoint salvo não permite descoberta")

    monkeypatch.setattr(plugin, "fetch_catalog", unexpected_fetch)
    registrations: Registrations = []
    plugin.register_models(collect_registrations(registrations))

    assert registrations == []
    assert "llm exp configure" in capsys.readouterr().err
    assert not config_path().exists()
    assert not cache_path().exists()


def test_hook_com_endpoint_salvo_invalido_nao_faz_fallback_silencioso(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    api_base = "https://arquivo.example.com/v1"
    save_endpoint("://endereco-invalido")
    save_cached_catalog(api_base, [RemoteModel("Kimi-K3")])

    def unexpected_call(*args: object, **kwargs: object) -> None:
        raise AssertionError("endpoint inválido deve interromper a descoberta")

    monkeypatch.setattr(plugin, "fetch_catalog", unexpected_call)
    monkeypatch.setattr(plugin.llm, "get_key", unexpected_call)
    registrations: Registrations = []
    plugin.register_models(collect_registrations(registrations))

    assert registrations == []
    captured = capsys.readouterr()
    assert "URL HTTP ou HTTPS válida" in captured.err
    assert "endereco-invalido" not in captured.err + captured.out


def test_hook_com_endpoint_sem_token_nao_faz_rede_e_usa_cache(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    api_base = "https://gateway.example.com/v1"
    save_endpoint(api_base)
    save_cached_catalog(api_base, [RemoteModel("Kimi-K3")])

    def unexpected_fetch(*args: object, **kwargs: object) -> list[RemoteModel]:
        raise AssertionError("não se deve consultar sem token")

    monkeypatch.setattr(plugin, "fetch_catalog", unexpected_fetch)
    registrations: Registrations = []
    plugin.register_models(collect_registrations(registrations))
    assert [sync.model_id for sync, _ in registrations] == ["exp/Kimi-K3"]
    assert "token não configurado" in capsys.readouterr().err


def test_falha_de_discovery_faz_fallback_e_emite_uma_mensagem(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    api_base = "https://gateway.example.com/v1"
    save_endpoint(api_base)
    save_cached_catalog(api_base, [RemoteModel("GLM-5.3")])
    monkeypatch.setattr(plugin.llm, "get_key", lambda **kwargs: "segredo")

    def fail_fetch(*args: object, **kwargs: object) -> list[RemoteModel]:
        raise DiscoveryError("Falha simulada sem credenciais.")

    monkeypatch.setattr(plugin, "fetch_catalog", fail_fetch)
    registrations: Registrations = []
    plugin.register_models(collect_registrations(registrations))
    assert [sync.model_id for sync, _ in registrations] == ["exp/GLM-5.3"]
    captured = capsys.readouterr()
    assert "Falha simulada" in captured.err
    assert "cache" in captured.err
    assert "segredo" not in captured.err + captured.out


def test_primeira_falha_sem_cache_nao_interrompe_llm(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    save_endpoint("https://gateway.example.com/v1")
    monkeypatch.setattr(plugin.llm, "get_key", lambda **kwargs: "segredo")

    def fail_fetch(*args: object, **kwargs: object) -> list[RemoteModel]:
        raise DiscoveryError("Gateway indisponível.")

    monkeypatch.setattr(plugin, "fetch_catalog", fail_fetch)
    registrations: Registrations = []
    plugin.register_models(collect_registrations(registrations))
    assert registrations == []
    assert "Nenhum catálogo" in capsys.readouterr().err


def test_refresh_a_cada_invocacao_substitui_catalogo_sem_stale_ou_duplicados(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api_base = "https://gateway.example.com/v1"
    save_endpoint(api_base)
    monkeypatch.setattr(plugin.llm, "get_key", lambda **kwargs: "segredo")
    snapshots = iter(
        [
            [RemoteModel("Kimi-K3"), RemoteModel("GLM-5.3")],
            [RemoteModel("Kimi-K3.1-Pro")],
        ]
    )
    calls: list[tuple[str, str, float]] = []

    def fake_fetch(base: str, key: str, timeout: float) -> list[RemoteModel]:
        calls.append((base, key, timeout))
        return next(snapshots)

    monkeypatch.setattr(plugin, "fetch_catalog", fake_fetch)
    monkeypatch.setenv("EXP_DISCOVERY_TIMEOUT", "1.25")

    first: Registrations = []
    second: Registrations = []
    plugin.register_models(collect_registrations(first))
    plugin.register_models(collect_registrations(second))

    assert [sync.model_id for sync, _ in first] == [
        "exp/Kimi-K3",
        "exp/GLM-5.3",
    ]
    assert [sync.model_id for sync, _ in second] == ["exp/Kimi-K3.1-Pro"]
    assert calls == [(api_base, "segredo", 1.25), (api_base, "segredo", 1.25)]
    cached = json.loads(cache_path().read_text(encoding="utf-8"))
    assert [model["id"] for model in cached["models"]] == ["Kimi-K3.1-Pro"]
    assert "segredo" not in cache_path().read_text(encoding="utf-8")


def test_registro_usa_chat_nativo_sync_async_tools_vision_e_metadados(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api_base = "https://gateway.example.com/v1"
    save_endpoint(api_base)
    monkeypatch.setattr(plugin.llm, "get_key", lambda **kwargs: "segredo")
    remote_models = [
        RemoteModel("Kimi-K3", 262144, 8192, True),
        RemoteModel("Qwen3.8-27B", 131072, None, False),
    ]
    monkeypatch.setattr(
        plugin,
        "fetch_catalog",
        lambda base, key, timeout: remote_models,
    )
    registrations: Registrations = []
    plugin.register_models(collect_registrations(registrations))

    assert len(registrations) == 2
    for (sync_model, async_model), remote in zip(registrations, remote_models):
        assert type(sync_model) is Chat
        assert type(async_model) is AsyncChat
        assert async_model is not None
        for model in (sync_model, async_model):
            assert model.model_id == f"exp/{remote.id}"
            assert model.model_name == remote.id
            assert model.api_base == api_base
            assert model.needs_key == "exp"
            assert model.key_env_var == "EXP_API_KEY"
            assert model.key is None
            assert model.supports_tools is True
            assert model.can_stream is True
            assert model.vision is remote.supports_vision
            assert model.max_input_tokens == remote.max_input_tokens
            assert model.max_output_tokens == remote.max_output_tokens
            assert model.default_max_tokens == remote.max_output_tokens


def test_erro_de_cache_na_escrita_nao_descarta_catalogo_novo(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    save_endpoint("https://gateway.example.com/v1")
    monkeypatch.setattr(plugin.llm, "get_key", lambda **kwargs: "segredo")
    monkeypatch.setattr(
        plugin,
        "fetch_catalog",
        lambda base, key, timeout: [RemoteModel("Kimi-K3")],
    )

    def fail_save(*args: object) -> None:
        raise OSError("disco cheio")

    monkeypatch.setattr(plugin, "save_cached_catalog", fail_save)
    registrations: Registrations = []
    plugin.register_models(collect_registrations(registrations))
    assert [sync.model_id for sync, _ in registrations] == ["exp/Kimi-K3"]
    assert "catálogo recém-obtido" in capsys.readouterr().err


def test_comando_e_registrado_sem_executar_discovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unexpected_fetch(*args: object, **kwargs: object) -> list[RemoteModel]:
        raise AssertionError("registro de comandos não pode fazer discovery")

    monkeypatch.setattr(plugin, "fetch_catalog", unexpected_fetch)
    root = click.Group()
    plugin.register_commands(root)
    assert root.commands["exp"] is plugin.exp
    assert plugin.exp.commands["configure"] is plugin.configure


def test_configure_interativo_usa_chave_nativa_e_nao_vaza_token(
    isolated_llm_user_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = "token-teste-nunca-exibir"
    api_base = "https://gateway.example.com/v1"

    def unexpected_fetch(*args: object, **kwargs: object) -> list[RemoteModel]:
        raise AssertionError("configure não pode fazer discovery")

    monkeypatch.setattr(plugin, "fetch_catalog", unexpected_fetch)
    result = CliRunner().invoke(
        plugin.exp,
        ["configure"],
        input=f"{token}\nhttps://gateway.example.com/\n",
    )
    assert result.exit_code == 0, result.output
    assert token not in result.output
    assert "Endpoint do gateway" in result.output
    config_raw = config_path().read_text(encoding="utf-8")
    assert token not in config_raw
    config = json.loads(config_raw)
    assert config == {"version": 1, "api_base": api_base}
    assert not cache_path().exists()
    assert llm.get_key(key_alias="exp", env_var="EXP_API_KEY") == token
    native_keys = isolated_llm_user_dir / "keys.json"
    assert native_keys.exists()
    assert native_keys.stat().st_mode & 0o777 == 0o600


def test_configure_com_endpoint_invalido_nao_salva_nem_vaza_token() -> None:
    token = "segredo-configure"
    result = CliRunner().invoke(
        plugin.exp,
        ["configure"],
        input=f"{token}\n://endereco-invalido\n",
    )
    assert result.exit_code != 0
    assert "URL HTTP ou HTTPS válida" in result.output
    assert token not in result.output
    assert not config_path().exists()
    assert not (config_path().parent / "keys.json").exists()


def test_configure_falha_ao_salvar_token_nao_salva_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_store(token: str) -> None:
        raise OSError("disco cheio")

    monkeypatch.setattr(plugin, "_store_api_key", fail_store)
    result = CliRunner().invoke(
        plugin.exp,
        ["configure"],
        input="token-nao-salvo\nhttps://gateway.example.com/\n",
    )
    assert result.exit_code != 0
    assert "token" in result.output
    assert "token-nao-salvo" not in result.output
    assert not config_path().exists()
    assert not (config_path().parent / "keys.json").exists()


def test_configure_falha_ao_salvar_endpoint_mantem_token_e_orienta_repeticao(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_save(api_base: str) -> None:
        raise OSError("disco cheio")

    monkeypatch.setattr(plugin, "save_endpoint", fail_save)
    result = CliRunner().invoke(
        plugin.exp,
        ["configure"],
        input="token-mantido\nhttps://gateway.example.com/\n",
    )
    assert result.exit_code != 0
    assert "endpoint" in result.output
    assert "token-mantido" not in result.output
    assert not config_path().exists()
    assert llm.get_key(key_alias="exp", env_var="EXP_API_KEY") == "token-mantido"


def test_configure_sem_mecanismo_nativo_de_chaves_orienta_e_nao_salva_nada(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import llm.cli

    class Unavailable:
        callback = None

    monkeypatch.setattr(llm.cli, "keys_set", Unavailable())
    result = CliRunner().invoke(
        plugin.exp,
        ["configure"],
        input="token-sem-mecanismo\nhttps://gateway.example.com/\n",
    )
    assert result.exit_code != 0
    assert "mecanismo nativo de chaves do llm" in result.output
    assert "token-sem-mecanismo" not in result.output
    assert not config_path().exists()
    assert not (config_path().parent / "keys.json").exists()
