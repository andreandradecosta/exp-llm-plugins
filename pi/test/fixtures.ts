import type { Model } from "@earendil-works/pi-ai/compat";
import { UNKNOWN_COST } from "../src/constants.ts";

export const REAL_MODEL_IDS = [
  "Kimi-K3",
  "Qwen3.8-Flash-Next",
  "GLM-5.3",
  "GLM-5.3-Flash",
  "glm-5.3-flash-harpia",
  "Qwen3.8-27B",
  "glm-5.3-harpia",
  "deepseek-v41-flash",
  "Kimi-K3.1-Pro",
] as const;

export const modelsFixture = {
  data: REAL_MODEL_IDS.map((id, index) => ({
    id,
    max_input_tokens: index % 2 === 0 ? String(200_000 + index) : 200_000 + index,
  })),
};

export const modelInfoFixture = {
  data: [
    ...REAL_MODEL_IDS.map((id, index) => ({
      model_name: id,
      model_info: {
        max_input_tokens: index % 2 === 0 ? 200_000 + index : String(200_000 + index),
        max_tokens: 200_000 + index,
        max_output_tokens: index === 0 ? 32_768 : 8_192,
        supports_vision: id === "Kimi-K3" || id === "Kimi-K3.1-Pro",
        ...(id === "Kimi-K3.1-Pro" ? { supports_reasoning: true } : {}),
      },
    })),
    {
      model_name: "MiniMax-M3",
      model_info: {
        max_input_tokens: 1_000_000,
        max_output_tokens: 64_000,
        supports_vision: true,
      },
    },
  ],
};

export function cachedModel(id = "Kimi-K3", baseUrl = "https://gateway.test/v1"): Model<"openai-completions"> {
  return {
    id,
    name: id,
    provider: "exp",
    api: "openai-completions",
    baseUrl,
    input: ["text"],
    reasoning: false,
    cost: { ...UNKNOWN_COST },
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
