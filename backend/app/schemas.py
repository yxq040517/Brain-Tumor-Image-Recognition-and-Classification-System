import json
from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .settings import BACKEND_DIR

TumorLabel = Literal["No Tumor", "Glioma", "Meningioma", "Pituitary"]
ReviewStatus = Literal["pending", "reviewed"]
LABELS: tuple[TumorLabel, ...] = ("No Tumor", "Glioma", "Meningioma", "Pituitary")
MODEL_MANIFEST = json.loads((BACKEND_DIR / "model-manifest.json").read_text(encoding="utf-8"))
MODEL_ID = MODEL_MANIFEST["model_id"]
MODEL_REVISION = MODEL_MANIFEST["revision"]
MODEL_SOURCE = MODEL_MANIFEST["source_url"]
MODEL_PARAMETERS = MODEL_MANIFEST["parameters"]
MODEL_OUTPUT_LABELS: tuple[TumorLabel, ...] = tuple(MODEL_MANIFEST["output_labels"])
REPORTED_ACCURACY = MODEL_MANIFEST["reported_accuracy"]

Score = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
GroupName = Annotated[str, Field(max_length=80)]


class Probability(BaseModel):
    label: TumorLabel
    score: Score


class ImageAnnotation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    type: Literal["rect"]
    x: Score
    y: Score
    width: Annotated[float, Field(gt=0, le=1, allow_inf_nan=False)]
    height: Annotated[float, Field(gt=0, le=1, allow_inf_nan=False)]
    text: str = Field(max_length=160)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")

    @model_validator(mode="after")
    def validate_bounds(self):
        if self.x + self.width > 1 or self.y + self.height > 1:
            raise ValueError("标注矩形必须完整位于影像内。")
        return self


def unique_annotations(annotations: list[ImageAnnotation]) -> list[ImageAnnotation]:
    if len({annotation.id for annotation in annotations}) != len(annotations):
        raise ValueError("标注编号不可重复。")
    return annotations


class Analysis(BaseModel):
    id: str
    filename: str
    width: int
    height: int
    created_at: str
    predicted_label: TumorLabel
    confidence: Score
    probabilities: list[Probability]
    inference_ms: float = Field(ge=0, allow_inf_nan=False)
    model_id: str
    model_revision: str
    image_url: str
    group: GroupName = ""
    notes: str = Field(default="", max_length=2000)
    reviewed_label: TumorLabel | None = None
    reviewed_at: str | None = None
    review_status: ReviewStatus = "pending"
    annotations: list[ImageAnnotation] = Field(default_factory=list, max_length=100)

    model_metadata: dict = Field(default_factory=dict)
    _unique_annotations = field_validator("annotations")(unique_annotations)


class AnalysisPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group: GroupName = ""
    notes: str = Field(default="", max_length=2000)
    reviewed_label: TumorLabel | None = None
    annotations: list[ImageAnnotation] = Field(default_factory=list, max_length=100)

    _unique_annotations = field_validator("annotations")(unique_annotations)


class ListOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=10, ge=1, le=100)
    label: TumorLabel | None = None
    query: str = Field(default="", max_length=180)
    group: GroupName | None = None
    review_status: ReviewStatus | None = None
    start_date: date | None = None
    end_date: date | None = None
    confidence_min: Score | None = None
    confidence_max: Score | None = None
    sort: Literal["newest", "oldest", "confidence_desc", "confidence_asc"] = "newest"

    @field_validator("label", "review_status", mode="before")
    @classmethod
    def empty_selection(cls, value):
        return None if value == "" else value

    @field_validator("start_date", "end_date", mode="before")
    @classmethod
    def local_date(cls, value):
        if isinstance(value, str):
            parsed = date.fromisoformat(value)
            if parsed.isoformat() != value:
                raise ValueError("日期必须使用 YYYY-MM-DD 格式。")
            return parsed
        if value is not None and type(value) is not date:
            raise ValueError("日期必须使用 YYYY-MM-DD 格式。")
        return value

    @model_validator(mode="after")
    def ordered_bounds(self):
        if self.start_date and self.end_date and self.start_date > self.end_date:
            raise ValueError("开始日期不得晚于结束日期。")
        if self.confidence_min is not None and self.confidence_max is not None:
            if self.confidence_min > self.confidence_max:
                raise ValueError("最低分数不得大于最高分数。")
        return self


class AnalysisPage(BaseModel):
    items: list[Analysis]
    total: int
    page: int
    page_size: int


class GroupCount(BaseModel):
    name: str
    count: int


class BulkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["delete", "group"]
    ids: list[UUID] = Field(min_length=1, max_length=200)
    group: GroupName | None = None

    @field_validator("ids")
    @classmethod
    def unique_ids(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("记录编号不可重复。")
        return value

    @model_validator(mode="after")
    def required_group(self):
        if self.action == "group" and self.group is None:
            raise ValueError("批量分组必须提供组名，空字符串表示未分组。")
        return self


class BulkResult(BaseModel):
    updated: list[Analysis] = Field(default_factory=list)
    deleted_ids: list[str] = Field(default_factory=list)


class ExportSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[UUID] | None = Field(default=None, min_length=1, max_length=200)
    filters: ListOptions | None = None

    @field_validator("ids")
    @classmethod
    def unique_ids(cls, value):
        if value is not None and len(set(value)) != len(value):
            raise ValueError("记录编号不可重复。")
        return value

    @model_validator(mode="after")
    def one_selection(self):
        if self.ids is not None and self.filters is not None:
            raise ValueError("请使用选中记录或筛选条件之一导出。")
        return self


class HeatmapResult(BaseModel):
    analysis_id: str
    heatmap_url: str
    predicted_label: TumorLabel
    width: int
    height: int
    method: Literal["Grad-CAM", "InputGradient"] = "Grad-CAM"
    model_revision: str


class ModelInfo(BaseModel):
    state: Literal["loading", "ready", "missing", "error"]
    model_id: str = MODEL_ID
    revision: str = MODEL_REVISION
    architecture: str = MODEL_MANIFEST["architecture"]
    device: str
    license: str = MODEL_MANIFEST["license"]
    reported_accuracy: float | None = REPORTED_ACCURACY
    parameters: int = MODEL_PARAMETERS
    input_size: int = MODEL_MANIFEST["input_size"]
    source_url: str = MODEL_SOURCE
    error: str | None = None
    profile_id: str = "builtin"
    name: str = "ViT 脑瘤分类模型"
    origin: Literal["builtin", "local"] = "builtin"
    labels: list[TumorLabel] = Field(default_factory=lambda: list(MODEL_OUTPUT_LABELS))
    input_width: int = 224
    input_height: int = 224
    size_bytes: int = MODEL_MANIFEST["weight_size"]
    heatmap_supported: bool = True
    heatmap_method: Literal["Grad-CAM", "InputGradient"] | None = "Grad-CAM"
    uploaded_at: str | None = None


class ModelProfile(BaseModel):
    id: str
    name: str
    origin: Literal["builtin", "local"]
    model_id: str
    revision: str
    architecture: str
    parameters: int
    input_size: int
    input_width: int
    input_height: int
    labels: list[TumorLabel]
    size_bytes: int
    created_at: str | None
    heatmap_supported: bool
    heatmap_method: Literal["Grad-CAM", "InputGradient"] | None
    active: bool = False


class ModelCatalog(BaseModel):
    active_id: str
    items: list[ModelProfile]


class Health(BaseModel):
    status: Literal["ok"] = "ok"
    model: ModelInfo


class LabelCount(BaseModel):
    label: TumorLabel
    count: int


class TrendPoint(BaseModel):
    date: str
    count: int
    mean_inference_ms: float | None


class LatencyBucket(BaseModel):
    name: str
    count: int


class Stats(BaseModel):
    total: int
    today: int
    mean_inference_ms: float | None
    distribution: list[LabelCount]
    reviewed: int
    pending: int
    trend: list[TrendPoint]
    latency: list[LatencyBucket]
