export type TumorLabel = "No Tumor" | "Glioma" | "Meningioma" | "Pituitary";
export const LABELS: Record<TumorLabel, { name: string; color: string }> = {
  "No Tumor": { name: "无肿瘤类", color: "#10b981" },
  Glioma: { name: "胶质瘤类", color: "#8b5cf6" },
  Meningioma: { name: "脑膜瘤类", color: "#3b82f6" },
  Pituitary: { name: "垂体瘤类", color: "#f59e0b" },
};
export interface Probability {
  label: TumorLabel;
  score: number;
}
export interface ImageAnnotation {
  id: string;
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
}
export type ReviewStatus = "pending" | "reviewed";
export interface Analysis {
  id: string;
  filename: string;
  width: number;
  height: number;
  created_at: string;
  predicted_label: TumorLabel;
  confidence: number;
  probabilities: Probability[];
  inference_ms: number;
  model_id: string;
  model_revision: string;
  image_url: string;
  group: string;
  notes: string;
  reviewed_label: TumorLabel | null;
  reviewed_at: string | null;
  review_status: ReviewStatus;
  annotations: ImageAnnotation[];
  model_metadata: Record<string, unknown>;
}
export interface AnalysisPage {
  items: Analysis[];
  total: number;
  page: number;
  page_size: number;
}
export interface ListOptions {
  page?: number;
  page_size?: number;
  label?: TumorLabel | "";
  query?: string;
  group?: string;
  review_status?: ReviewStatus | "";
  start_date?: string;
  end_date?: string;
  confidence_min?: number;
  confidence_max?: number;
  sort?: "newest" | "oldest" | "confidence_desc" | "confidence_asc";
}
export interface AnalysisPatch {
  group?: string;
  notes?: string;
  reviewed_label?: TumorLabel | null;
  annotations?: ImageAnnotation[];
}
export interface GroupCount {
  name: string;
  count: number;
}
export interface BulkResult {
  updated: Analysis[];
  deleted_ids: string[];
}
export interface ExportSelection {
  ids?: string[];
  filters?: ListOptions;
}
export type ExportFormat = "pdf" | "excel";
export interface HeatmapResult {
  analysis_id: string;
  heatmap_url: string;
  predicted_label: TumorLabel;
  width: number;
  height: number;
  method: "Grad-CAM" | "InputGradient";
  model_revision: string;
}
export interface ModelInfo {
  state: "loading" | "ready" | "missing" | "error";
  model_id: string;
  revision: string;
  architecture: string;
  device: string;
  license: string;
  reported_accuracy: number | null;
  parameters: number;
  input_size: number;
  source_url: string;
  error: string | null;
  profile_id: string;
  name: string;
  origin: "builtin" | "local";
  labels: TumorLabel[];
  input_width: number;
  input_height: number;
  size_bytes: number;
  heatmap_supported: boolean;
  heatmap_method: "Grad-CAM" | "InputGradient" | null;
  uploaded_at: string | null;
}
export interface ModelProfile {
  id: string;
  name: string;
  origin: "builtin" | "local";
  model_id: string;
  revision: string;
  architecture: string;
  parameters: number;
  input_size: number;
  input_width: number;
  input_height: number;
  labels: TumorLabel[];
  size_bytes: number;
  created_at: string | null;
  heatmap_supported: boolean;
  heatmap_method: "Grad-CAM" | "InputGradient" | null;
  active: boolean;
}
export interface ModelCatalog {
  active_id: string;
  items: ModelProfile[];
}
export interface Health {
  status: "ok";
  model: ModelInfo;
}
export interface TrendPoint {
  date: string;
  count: number;
  mean_inference_ms: number | null;
}
export interface LatencyBucket {
  name: string;
  count: number;
}
export interface Stats {
  total: number;
  today: number;
  mean_inference_ms: number | null;
  reviewed: number;
  pending: number;
  distribution: { label: TumorLabel; count: number }[];
  trend: TrendPoint[];
  latency: LatencyBucket[];
}
