import type {
  Analysis,
  AnalysisPage,
  AnalysisPatch,
  BulkResult,
  ExportFormat,
  ExportSelection,
  GroupCount,
  HeatmapResult,
  ListOptions,
  ModelCatalog,
  ModelInfo,
  ModelProfile,
  Stats,
  TumorLabel,
} from "./types";

async function response(path: string, init?: RequestInit): Promise<Response> {
  let result: Response;
  try {
    result = await fetch(`/api${path}`, { cache: "no-store", ...init });
  } catch {
    throw new Error("无法连接本地服务，请启动系统后重试。");
  }
  if (!result.ok) {
    let message = `请求失败（${result.status}）`;
    try {
      const body = await result.json();
      if (typeof body.detail === "string") message = body.detail;
      else if (Array.isArray(body.detail)) message = "提交内容不完整或格式不正确。";
    } catch {
      /* Non-JSON responses retain their HTTP status. */
    }
    throw new Error(message);
  }
  return result;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await response(path, init);
  if (result.status === 204) return undefined as T;
  return result.json() as Promise<T>;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export const api = {
  model: () => request<ModelInfo>("/model"),
  models: () => request<ModelCatalog>("/models"),
  activateModel: (id: string) =>
    request<ModelInfo>(`/models/${encodeURIComponent(id)}/activate`, { method: "POST" }),
  removeModel: (id: string) =>
    request<void>(`/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  uploadModel: (files: File[], name: string, labels?: TumorLabel[]) => {
    const body = new FormData();
    body.append("name", name);
    if (labels) body.append("labels_json", JSON.stringify(labels));
    for (const file of files) body.append("files", file, file.webkitRelativePath || file.name);
    return request<ModelProfile>("/models/upload", { method: "POST", body });
  },
  stats: (days: 7 | 30 = 7) => request<Stats>(`/stats?days=${days}`),
  groups: () => request<GroupCount[]>("/groups"),
  list: (options: ListOptions = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || (value === "" && key !== "group")) continue;
      query.set(key, String(value));
    }
    return request<AnalysisPage>(`/analyses?${query}`);
  },
  get: (id: string) => request<Analysis>(`/analyses/${encodeURIComponent(id)}`),
  analyze: (file: File, group = "") => {
    const body = new FormData();
    body.append("file", file);
    if (group) body.append("group", group);
    return request<Analysis>("/analyses", { method: "POST", body });
  },
  update: (id: string, patch: AnalysisPatch) =>
    request<Analysis>(`/analyses/${encodeURIComponent(id)}`, json("PATCH", patch)),
  remove: (id: string) =>
    request<void>(`/analyses/${encodeURIComponent(id)}`, { method: "DELETE" }),
  bulk: (action: "delete" | "group", ids: string[], group?: string) =>
    request<BulkResult>(
      "/analyses/bulk",
      json("POST", { action, ids, ...(group !== undefined ? { group } : {}) }),
    ),
  heatmap: (id: string) =>
    request<HeatmapResult>(`/analyses/${encodeURIComponent(id)}/heatmap`, { method: "POST" }),
  export: async (
    format: ExportFormat,
    selection: ExportSelection,
  ): Promise<{ blob: Blob; filename: string }> => {
    const result = await response(`/exports/${format}`, json("POST", selection));
    const header = result.headers.get("content-disposition") ?? "";
    const filename =
      /filename="([^"]+)"/.exec(header)?.[1] ?? `neurolens.${format === "excel" ? "xlsx" : "pdf"}`;
    return { blob: await result.blob(), filename };
  },
};

export async function downloadExport(
  format: ExportFormat,
  selection: ExportSelection,
): Promise<void> {
  const { blob, filename } = await api.export(format, selection);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
