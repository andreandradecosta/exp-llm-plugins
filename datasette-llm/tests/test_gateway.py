import httpx
import pytest

from llm_exp_gateway.gateway import (
    DiscoveryError,
    fetch_catalog,
    merge_model_info,
    normalize_endpoint,
    parse_models_payload,
    parse_token_limit,
)

MODEL_IDS = [
    "Kimi-K3",
    "Qwen3.8-Flash-Next",
    "GLM-5.3",
    "GLM-5.3-Flash",
    "glm-5.3-flash-harpia",
    "Qwen3.8-27B",
    "glm-5.3-harpia",
    "deepseek-v41-flash",
    "Kimi-K3.1-Pro",
] + ["MiniMax-M3"]


def models_payload() -> dict[str, object]:
    return {
        "object": "list",
        "data": [
            {
                "id": model_id,
                "object": "model",
                "created": 1700000000,
                "owned_by": "exp",
                "max_input_tokens": "262144" if model_id == "Kimi-K3" else 131072,
            }
            for model_id in MODEL_IDS[:9]
        ],
    }


def info_payload() -> dict[str, object]:
    return {
        "data": [
            *[
                {
                    "model_name": model_id,
                    "model_info": {
                        "max_input_tokens": 262144,
                        "max_tokens": 262144,
                        "max_output_tokens": "8192",
                        "supports_vision": model_id in ("Kimi-K3", "GLM-5.3"),
                    },
                }
                for model_id in MODEL_IDS[:9]
            ],
            {
                "model_name": "MiniMax-M3",
                "model_info": {
                    "max_input_tokens": 999999,
                    "max_output_tokens": 99999,
                    "supports_vision": True,
                },
            },
        ]
    }


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://gateway.example.com", "https://gateway.example.com/v1"),
        ("https://gateway.example.com/", "https://gateway.example.com/v1"),
        ("https://gateway.example.com/v1", "https://gateway.example.com/v1"),
        (" https://gateway.example.com/v1/// ", "https://gateway.example.com/v1"),
        ("http://localhost:4000/custom", "http://localhost:4000/custom/v1"),
    ],
)
def test_normalize_endpoint(raw: str, expected: str) -> None:
    assert normalize_endpoint(raw) == expected


@pytest.mark.parametrize("raw", ["", "gateway.example.com", "ftp://example.com"])
def test_normalize_endpoint_rejeita_urls_invalidas(raw: str) -> None:
    with pytest.raises(ValueError):
        normalize_endpoint(raw)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (262144, 262144),
        ("262144", 262144),
        (" 8192 ", 8192),
        (8192.0, 8192),
        (0, None),
        (-1, None),
        (1.5, None),
        (True, None),
        ("não numérico", None),
        (None, None),
    ],
)
def test_parse_token_limit(value: object, expected: int | None) -> None:
    assert parse_token_limit(value) == expected


def test_models_e_autoritativo_e_info_apenas_enriquece() -> None:
    models = parse_models_payload(models_payload())
    enriched = merge_model_info(models, info_payload())

    assert [model.id for model in enriched] == MODEL_IDS[:9]
    assert "MiniMax-M3" not in {model.id for model in enriched}
    by_id = {model.id: model for model in enriched}
    assert by_id["Kimi-K3"].max_input_tokens == 262144
    assert by_id["Kimi-K3"].max_output_tokens == 8192
    assert by_id["Kimi-K3"].supports_vision is True
    assert by_id["GLM-5.3"].supports_vision is True
    assert by_id["Qwen3.8-27B"].supports_vision is False


def test_models_remove_duplicatas_e_ignora_itens_invalidos() -> None:
    payload: dict[str, object] = {
        "data": [
            {"id": "Kimi-K3", "max_input_tokens": "100"},
            {"id": "Kimi-K3", "max_input_tokens": "200"},
            {"id": 42},
            "inválido",
        ]
    }
    models = parse_models_payload(payload)
    assert len(models) == 1
    assert models[0].id == "Kimi-K3"
    assert models[0].max_input_tokens == 200


def test_fetch_usa_bearer_nos_dois_requests_e_normaliza_caminhos() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/v1/models":
            return httpx.Response(200, json=models_payload())
        if request.url.path == "/v1/model/info":
            return httpx.Response(200, json=info_payload())
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        models = fetch_catalog(
            "https://gateway.example.com/v1",
            "token-de-teste",
            timeout=1.0,
            client=client,
        )

    assert len(models) == 9
    assert [request.url.path for request in requests] == [
        "/v1/models",
        "/v1/model/info",
    ]
    assert all(
        request.headers["Authorization"] == "Bearer token-de-teste"
        for request in requests
    )


def test_falha_de_info_nao_bloqueia_models() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return httpx.Response(200, json=models_payload())
        return httpx.Response(500, json={"error": "não deve vazar na mensagem"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        models = fetch_catalog(
            "https://gateway.example.com/v1", "segredo", client=client
        )
    assert len(models) == 9
    assert all(model.max_output_tokens is None for model in models)
    assert all(model.supports_vision is False for model in models)


def test_erro_de_conexao_em_info_tambem_e_opcional() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return httpx.Response(200, json=models_payload())
        raise httpx.ConnectError("falha simulada", request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        models = fetch_catalog(
            "https://gateway.example.com/v1", "segredo", client=client
        )
    assert len(models) == 9


@pytest.mark.parametrize("status", [401, 403])
def test_erros_de_autenticacao_orientam_sem_vazar_token(status: int) -> None:
    token = "token-super-secreto"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": token})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(DiscoveryError) as caught:
            fetch_catalog("https://gateway.example.com/v1", token, client=client)
    message = str(caught.value)
    assert str(status) in message
    assert "llm exp configure" in message
    assert "EXP_API_KEY" in message
    assert token not in message


def test_payload_models_invalido_gera_erro_claro() -> None:
    with pytest.raises(DiscoveryError, match="lista 'data'"):
        parse_models_payload({"data": {"id": "Kimi-K3"}})
