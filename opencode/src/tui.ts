import { Plugin } from "@opencode/plugin/tui"
import { asExpStatus, ExpRpc, type ExpStatus } from "./rpc.ts"

export default Plugin.define({
  id: "exp.gateway.tui",
  setup(context) {
    const location = () => context.location ?? context.data.location.default()

    const invalidate = () => {
      context.data.location.model.invalidate(location())
      context.data.location.provider.invalidate(location())
      context.data.location.integration.invalidate(location())
    }

    const refresh = async (automatic: boolean): Promise<ExpStatus | undefined> => {
      try {
        const status = asExpStatus(await context.client.rpc(ExpRpc).refresh({}))
        invalidate()
        if (automatic && status.lastError) {
          context.ui.toast.show({
            title: "LiteLLM (exp)",
            message: status.lastError,
            variant: "warning",
          })
        }
        return status
      } catch {
        if (!automatic) {
          context.ui.toast.show({
            title: "LiteLLM (exp)",
            message: "Não foi possível chamar o RPC do server. Verifique se o plugin está ativo.",
            variant: "error",
          })
        }
        return undefined
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "exp.setup",
          title: "Configurar gateway LiteLLM",
          group: "LiteLLM",
          palette: true,
          slash: { name: "exp-setup" },
          run: async () => {
            try {
              const current = asExpStatus(await context.client.rpc(ExpRpc).status({}))
              const endpoint = await context.ui.dialog.prompt({
                title: "Endpoint do gateway LiteLLM",
                description: "Use uma URL http(s), com ou sem /v1. O token NÃO deve ser informado aqui.",
                placeholder: "http://gateway:4001",
                ...(current.endpoint ? { value: current.endpoint } : {}),
              })
              if (endpoint === undefined) return

              const status = asExpStatus(await context.client.rpc(ExpRpc).configure({ endpoint }))
              invalidate()
              showResult((options) => context.ui.toast.show(options), status, "Endpoint salvo e catálogo atualizado.")
            } catch {
              context.ui.toast.show({
                title: "LiteLLM (exp)",
                message: "Não foi possível configurar o endpoint pelo RPC do server.",
                variant: "error",
              })
            }
          },
        },
        {
          id: "exp.refresh",
          title: "Atualizar modelos do gateway LiteLLM",
          group: "LiteLLM",
          palette: true,
          slash: { name: "exp-refresh" },
          run: async () => {
            const status = await refresh(false)
            if (status) showResult((options) => context.ui.toast.show(options), status, "Catálogo atualizado.")
          },
        },
        {
          id: "exp.status",
          title: "Status do gateway LiteLLM",
          group: "LiteLLM",
          palette: true,
          slash: { name: "exp-status" },
          run: async () => {
            try {
              const status = asExpStatus(await context.client.rpc(ExpRpc).status({}))
              await context.ui.dialog.alert({
                title: "LiteLLM (exp)",
                message: formatStatus(status),
              })
            } catch {
              context.ui.toast.show({
                title: "LiteLLM (exp)",
                message: "Não foi possível consultar o status pelo RPC do server.",
                variant: "error",
              })
            }
          },
        },
      ],
    }))

    // The shared server can outlive the TUI: always request a fresh catalog on open.
    void refresh(true)
  },
})

function showResult(
  show: (options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }) => void,
  status: ExpStatus,
  successMessage: string,
): void {
  if (status.lastError) {
    show({ title: "LiteLLM (exp)", message: status.lastError, variant: "error" })
    return
  }
  if (status.lastWarning) {
    show({ title: "LiteLLM (exp)", message: status.lastWarning, variant: "warning" })
    return
  }
  show({
    title: "LiteLLM (exp)",
    message: `${successMessage} ${status.modelCount} modelo(s) disponível(is).`,
    variant: "success",
  })
}

function formatStatus(status: ExpStatus): string {
  return [
    `Endpoint: ${status.endpoint ?? "não configurado"}`,
    `Conexão nativa: ${status.authenticated ? "autenticada" : status.connected ? "sem token utilizável" : "ausente"}`,
    `Catálogo: ${status.modelCount} modelo(s) ativo(s), ${status.cachedModelCount} em cache`,
    `Último catálogo válido: ${status.catalogUpdatedAt ?? "nenhum"}`,
    `Metadados model/info: ${status.metadataStatus}`,
    `Último refresh: ${status.lastRefresh}`,
    status.lastWarning ? `Aviso: ${status.lastWarning}` : undefined,
    status.lastError ? `Erro: ${status.lastError}` : undefined,
    "Selecione modelos como exp/<id> em /models. Tokens são gerenciados somente por /connect.",
  ].filter((line): line is string => line !== undefined).join("\n")
}

export { formatStatus }
