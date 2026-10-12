import logging
import math
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from time import perf_counter
from typing import Any

from PIL import Image

from .model_registry import (
    MAX_CONFIG_BYTES,
    MAX_PARAMETERS,
    REQUIRED_FILES,
    ModelConfigurationError,
    ModelRegistry,
    canonical_labels,
    file_digest,
    read_json,
    validate_files,
)
from .schemas import (
    LABELS,
    MODEL_ID,
    MODEL_MANIFEST,
    MODEL_OUTPUT_LABELS,
    MODEL_PARAMETERS,
    MODEL_REVISION,
    ModelInfo,
    ModelProfile,
    Probability,
    TumorLabel,
)
from .settings import BACKEND_DIR, Settings

logger = logging.getLogger(__name__)
WEIGHT_SHA256 = MODEL_MANIFEST["weight_sha256"]
WEIGHT_SIZE = MODEL_MANIFEST["weight_size"]


class ModelUnavailable(RuntimeError):
    pass


@dataclass
class _Candidate:
    processor: Any
    model: Any
    torch: Any
    info: ModelInfo


def _reject_remote(value: Any) -> None:
    if isinstance(value, dict):
        if "auto_map" in value or "custom_pipelines" in value:
            raise ModelConfigurationError(
                "不支持远程代码或自定义 Python 模型，请导出 Transformers 内置视觉分类架构。"
            )
        for item in value.values():
            _reject_remote(item)
    elif isinstance(value, list):
        for item in value:
            _reject_remote(item)


def _dimensions(processor: Any, config: Any) -> tuple[int, int]:
    size = (
        getattr(processor, "crop_size", None)
        if getattr(processor, "do_center_crop", False)
        else None
    )
    size = size or getattr(processor, "size", None) or getattr(config, "image_size", None)
    if isinstance(size, dict):
        height = size.get("height", size.get("shortest_edge", size.get("longest_edge")))
        width = size.get("width", size.get("shortest_edge", size.get("longest_edge")))
    elif isinstance(size, (list, tuple)) and len(size) == 2:
        height, width = size
    else:
        height = width = size
    if (
        not isinstance(height, int)
        or isinstance(height, bool)
        or not isinstance(width, int)
        or isinstance(width, bool)
        or not 1 <= height <= 1024
        or not 1 <= width <= 1024
    ):
        raise ModelConfigurationError("无法确定模型输入尺寸，或尺寸超出 1–1024 像素限制。")
    return width, height


def _safe_tensor_count(path: Path) -> int:
    # Check the header size before the Rust reader parses potentially untrusted metadata.
    with path.open("rb") as handle:
        size_bytes = handle.read(8)
        if len(size_bytes) != 8:
            raise ModelConfigurationError("safetensors 权重文件不完整。")
        header_size = int.from_bytes(size_bytes, "little")
        if not 2 <= header_size <= 8 * MAX_CONFIG_BYTES or header_size + 8 > path.stat().st_size:
            raise ModelConfigurationError("safetensors 元数据大小异常。")
    from safetensors import safe_open

    count = 0
    try:
        with safe_open(str(path), framework="pt", device="cpu") as handle:
            keys = list(handle.keys())
            if not keys or len(keys) > 100_000:
                raise ModelConfigurationError("模型权重张量数量异常。")
            for key in keys:
                shape = handle.get_slice(key).get_shape()
                if len(shape) > 8 or any(dimension <= 0 for dimension in shape):
                    raise ModelConfigurationError("模型权重张量形状无效。")
                count += math.prod(shape)
                if count > MAX_PARAMETERS:
                    raise ModelConfigurationError("模型权重超过 2.5 亿参数限制。")
    except ModelConfigurationError:
        raise
    except Exception as exc:
        raise ModelConfigurationError(
            "无法读取 safetensors 权重，文件损坏或格式不受支持。"
        ) from exc
    return count


def _check_configuration_bounds(value: Any, key: str = "") -> None:
    # Bound construction work too: a meta-device prevents tensor allocation, not huge module lists.
    if isinstance(value, dict):
        for name, item in value.items():
            _check_configuration_bounds(item, name)
    elif isinstance(value, list):
        if len(value) > 1024:
            raise ModelConfigurationError("模型配置数组过大。")
        if key in {"depths", "num_blocks", "hidden_sizes", "num_heads"} and len(value) > 32:
            raise ModelConfigurationError("模型分阶段配置超过安全限制。")
        if (
            key in {"depths", "num_blocks"}
            and all(isinstance(item, int) for item in value)
            and sum(value) > 128
        ):
            raise ModelConfigurationError("模型总层数超过安全限制。")
        for item in value:
            _check_configuration_bounds(item, key)
    elif isinstance(value, int) and not isinstance(value, bool):
        depth_keys = {
            "num_hidden_layers",
            "num_layers",
            "num_encoder_layers",
            "depth",
            "depths",
            "num_blocks",
            "num_stages",
        }
        if key in depth_keys and not 0 < value <= 128:
            raise ModelConfigurationError("模型层数超出安全限制。")
        if (
            key
            in {
                "hidden_size",
                "embed_dim",
                "embedding_size",
                "hidden_sizes",
                "num_channels",
                "num_attention_heads",
                "num_heads",
                "intermediate_size",
            }
            and not 0 < value <= 32768
        ):
            raise ModelConfigurationError("模型通道或隐藏层尺寸超出安全限制。")
        if (
            key in {"image_size", "height", "width", "shortest_edge", "longest_edge"}
            and not 0 < value <= 1024
        ):
            raise ModelConfigurationError("模型输入尺寸不能超过 1024 像素。")


class ModelEngine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.registry = ModelRegistry(settings)
        self._state_lock = Lock()
        self._prediction_lock = Lock()
        self._activation_lock = Lock()
        self._candidate_lock = Lock()
        self._info = ModelInfo(state="loading", device=settings.device)
        self._processor = None
        self._model = None
        self._torch = None

    def info(self) -> ModelInfo:
        with self._state_lock:
            return self._info.model_copy(deep=True)

    def require_ready(self) -> None:
        info = self.info()
        if info.state != "ready":
            raise ModelUnavailable(info.error or "模型正在加载，请稍后重试。")

    def _verify_artifacts(self, directory: Path) -> None:
        if directory.is_symlink() or directory.is_junction():
            raise ModelConfigurationError("内置模型目录不能为符号链接。")
        missing = [
            name
            for name in (*REQUIRED_FILES, "provenance.json")
            if not (directory / name).is_file()
        ]
        if missing:
            raise FileNotFoundError("缺少本地模型文件或来源凭据，请运行启动脚本准备固定版本模型。")
        manifest = read_json(BACKEND_DIR / "model-manifest.json")
        if manifest.get("model_id") != MODEL_ID or manifest.get("revision") != MODEL_REVISION:
            raise ModelConfigurationError("项目模型清单与固定版本不一致，请恢复系统模型清单。")
        expected = manifest.get("sha256", {})
        if (
            not isinstance(expected, dict)
            or set(expected) != set(REQUIRED_FILES)
            or expected != MODEL_MANIFEST["sha256"]
        ):
            raise ModelConfigurationError("项目模型清单缺少固定校验值，请恢复完整系统模型清单。")
        provenance = read_json(directory / "provenance.json")
        if provenance.get("model_id") != MODEL_ID or provenance.get("revision") != MODEL_REVISION:
            raise ModelConfigurationError(
                "本地模型来源凭据与系统固定的模型及版本不一致，请重新准备模型。"
            )
        digests = provenance.get("sha256", {})
        if not isinstance(digests, dict) or digests != expected:
            raise ModelConfigurationError(
                "模型来源凭据中的校验值与项目固定清单不一致，请重新准备模型。"
            )
        for name in REQUIRED_FILES:
            path = directory / name
            value = expected.get(name)
            if (
                path.is_symlink()
                or path.is_junction()
                or not isinstance(value, str)
                or len(value) != 64
                or file_digest(path) != value
            ):
                raise ModelConfigurationError(
                    "本地模型文件校验失败，文件可能损坏或被替换，请重新准备模型。"
                )
        if (
            digests.get("model.safetensors") != WEIGHT_SHA256
            or (directory / "model.safetensors").stat().st_size != WEIGHT_SIZE
        ):
            raise ModelConfigurationError("本地权重不是系统固定的完整发布文件，请重新准备模型。")
        config = read_json(directory / "config.json")
        if (
            config.get("id2label") != MODEL_MANIFEST["id2label"]
            or len(MODEL_OUTPUT_LABELS) != len(LABELS)
            or set(MODEL_OUTPUT_LABELS) != set(LABELS)
        ):
            raise ModelConfigurationError("模型类别及顺序与系统不一致，不能进行分类。")
        if config.get("model_type") != MODEL_MANIFEST["model_type"] or config.get(
            "architectures"
        ) != [MODEL_MANIFEST["model_class"]]:
            raise ModelConfigurationError("模型架构与固定版本不一致，不能进行分类。")

    @staticmethod
    def _verify_builtin_processor(processor: Any) -> None:
        if (
            processor.size != {"height": 224, "width": 224}
            or not processor.do_resize
            or int(processor.resample) != 2
            or not processor.do_rescale
            or not math.isclose(processor.rescale_factor, 1 / 255, rel_tol=1e-12)
            or not processor.do_normalize
            or list(processor.image_mean) != [0.5, 0.5, 0.5]
            or list(processor.image_std) != [0.5, 0.5, 0.5]
            or getattr(processor, "do_center_crop", False)
        ):
            raise ModelConfigurationError(
                "模型预处理配置不符合固定版本：须为 224×224 双线性缩放和官方归一化。"
            )

    def _build_candidate(self, directory: Path, profile: ModelProfile) -> _Candidate:
        try:
            if profile.origin == "builtin":
                self._verify_artifacts(directory)
            else:
                validate_files(directory, calculate_hashes=False)
            raw = read_json(directory / "config.json")
            preprocessing = read_json(directory / "preprocessor_config.json")
            _reject_remote(raw)
            _reject_remote(preprocessing)
            _check_configuration_bounds(raw)
            _check_configuration_bounds(preprocessing)
            mapping = canonical_labels(raw, profile.labels)
            if "id2label" in raw and (
                not isinstance(raw["id2label"], dict)
                or set(raw["id2label"]) != {"0", "1", "2", "3"}
            ):
                raise ModelConfigurationError("模型必须具有恰好四个分类输出。")
            if "num_labels" in raw and raw["num_labels"] != 4:
                raise ModelConfigurationError("模型分类头不是四分类，不能用于脑瘤分类。")
            _safe_tensor_count(directory / "model.safetensors")
            import torch
            from transformers import AutoConfig, AutoImageProcessor, AutoModelForImageClassification

            torch.set_num_threads(self.settings.torch_threads)
            if self.settings.device == "cuda" and not torch.cuda.is_available():
                raise ModelConfigurationError(
                    "已配置 CUDA，但当前环境没有可用的 CUDA 设备，请改用 CPU。"
                )
            config = AutoConfig.from_pretrained(
                directory, local_files_only=True, trust_remote_code=False
            )
            if config.num_labels != 4:
                raise ModelConfigurationError(
                    "模型分类头不是四分类；不能创建随机分类头替代上传权重。"
                )
            if type(config) not in AutoModelForImageClassification._model_mapping:
                raise ModelConfigurationError("该架构不是 Transformers 内置视觉分类模型。")
            model_class = AutoModelForImageClassification._model_mapping[type(config)]
            model_classes = model_class if isinstance(model_class, tuple) else (model_class,)
            architectures = raw.get("architectures")
            if architectures and (
                not isinstance(architectures, list)
                or any(
                    name not in {cls.__name__ for cls in model_classes} for name in architectures
                )
            ):
                raise ModelConfigurationError(
                    "模型 architectures 与标准视觉分类架构不一致，不支持自定义分类器。"
                )
            with torch.device("meta"):
                skeleton = AutoModelForImageClassification.from_config(
                    config, trust_remote_code=False
                )
            parameters = sum(parameter.numel() for parameter in skeleton.parameters())
            architecture = skeleton.__class__.__name__
            del skeleton
            if not 0 < parameters <= MAX_PARAMETERS:
                raise ModelConfigurationError("模型参数超过 2.5 亿参数安全限制。")
            processor = AutoImageProcessor.from_pretrained(
                directory, use_fast=False, local_files_only=True, trust_remote_code=False
            )
            width, height = _dimensions(processor, config)
            if profile.origin == "builtin":
                self._verify_builtin_processor(processor)
            model, loading = AutoModelForImageClassification.from_pretrained(
                directory,
                config=config,
                local_files_only=True,
                trust_remote_code=False,
                use_safetensors=True,
                dtype=torch.float32,
                output_loading_info=True,
            )
            if any(
                loading.get(key)
                for key in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs")
            ):
                raise ModelConfigurationError(
                    "模型权重与架构或分类头不完全匹配；拒绝缺失、额外或尺寸不符的权重，不能随机补齐分类头。"
                )
            actual_parameters = sum(parameter.numel() for parameter in model.parameters())
            if actual_parameters != parameters or (
                profile.origin == "builtin" and actual_parameters != MODEL_PARAMETERS
            ):
                raise ModelConfigurationError("模型参数数量与配置或固定版本不符。")
            if profile.origin == "builtin" and model.config.id2label != {
                int(index): label for index, label in MODEL_MANIFEST["id2label"].items()
            }:
                raise ModelConfigurationError("加载后模型类别顺序不正确，不能进行分类。")
            model.eval()
            model.requires_grad_(False)
            model.to(self.settings.device)
            blank = Image.new("RGB", (width, height))
            try:
                with torch.inference_mode():
                    inputs = processor(images=blank, return_tensors="pt")
                    pixel_values = inputs.get("pixel_values")
                    if (
                        pixel_values is None
                        or pixel_values.ndim != 4
                        or pixel_values.shape[:2] != (1, 3)
                    ):
                        raise ModelConfigurationError("预处理必须产生单张 RGB 图像张量。")
                    actual_height, actual_width = map(int, pixel_values.shape[-2:])
                    if (
                        not 1 <= actual_height <= 1024
                        or not 1 <= actual_width <= 1024
                        or not bool(torch.isfinite(pixel_values).all())
                    ):
                        raise ModelConfigurationError("预处理尺寸或数值超出安全范围。")
                    inputs = {
                        name: tensor.to(self.settings.device) for name, tensor in inputs.items()
                    }
                    logits = model(**inputs).logits
                    if logits.shape != (1, 4) or not bool(torch.isfinite(logits).all()):
                        raise ModelConfigurationError("模型验证失败：必须输出四个有限分类分数。")
            finally:
                blank.close()
            # Crop/pad transforms cannot be blindly stretched back over the entire source.
            aligned = not any(
                bool(getattr(processor, flag, False))
                for flag in (
                    "do_center_crop",
                    "do_random_crop",
                    "do_crop",
                    "do_pad",
                    "do_thumbnail",
                    "do_flip",
                    "do_align_long_axis",
                    "do_square",
                )
            )
            # ConvNext's small-image branch crops internally without a do_center_crop flag.
            if processor.__class__.__name__ == "ConvNextImageProcessor":
                aligned = (
                    aligned
                    and isinstance(processor.size, dict)
                    and processor.size.get("shortest_edge", 0) >= 384
                )
            vit = getattr(model, "vit", None)
            gradcam = False
            if aligned and vit is not None and hasattr(vit, "encoder") and len(vit.encoder.layer):
                patch = getattr(model.config, "patch_size", None)
                patch_height, patch_width = (
                    patch if isinstance(patch, (tuple, list)) else (patch, patch)
                )
                gradcam = (
                    isinstance(patch_height, int)
                    and isinstance(patch_width, int)
                    and patch_height > 0
                    and patch_width > 0
                    and actual_height % patch_height == 0
                    and actual_width % patch_width == 0
                    and hasattr(vit.encoder.layer[-1], "layernorm_before")
                )
            info = ModelInfo(
                state="ready",
                device=self.settings.device,
                profile_id=profile.id,
                name=profile.name,
                origin=profile.origin,
                model_id=profile.model_id,
                revision=profile.revision,
                architecture=MODEL_MANIFEST["architecture"]
                if profile.origin == "builtin"
                else architecture,
                parameters=actual_parameters,
                input_size=max(actual_width, actual_height),
                input_width=actual_width,
                input_height=actual_height,
                labels=mapping,
                size_bytes=profile.size_bytes,
                uploaded_at=profile.created_at,
                reported_accuracy=MODEL_MANIFEST["reported_accuracy"]
                if profile.origin == "builtin"
                else None,
                license=MODEL_MANIFEST["license"] if profile.origin == "builtin" else "未声明",
                source_url=MODEL_MANIFEST["source_url"]
                if profile.origin == "builtin"
                else "本地上传",
                heatmap_supported=aligned,
                heatmap_method=("Grad-CAM" if gradcam else "InputGradient") if aligned else None,
            )
            return _Candidate(processor=processor, model=model, torch=torch, info=info)
        except (ModelConfigurationError, FileNotFoundError):
            raise
        except Exception as exc:
            logger.exception("候选模型验证失败")
            raise ModelConfigurationError(
                "模型验证失败：请检查标准视觉分类架构、完整 safetensors 权重、"
                "四分类头、预处理配置和可用内存。"
            ) from exc

    def validate_profile(self, directory: Path, profile: ModelProfile) -> ModelInfo:
        with self._candidate_lock:
            candidate = self._build_candidate(directory, profile)
            # Dispose before another validation allocates a classifier; never cache unused uploads.
            info = candidate.info.model_copy(deep=True)
            del candidate
            return info

    def _install(self, candidate: _Candidate) -> None:
        self._processor = candidate.processor
        self._model = candidate.model
        self._torch = candidate.torch
        with self._state_lock:
            self._info = candidate.info.model_copy(deep=True)

    def load(self) -> None:
        with self._activation_lock, self._candidate_lock:
            self._load_selected()

    def _load_selected(self) -> None:
        profile_id = "invalid"
        profile = None
        try:
            profile_id = self.registry.active_id()
            profile = self.registry.get(profile_id)
            self.registry.verify_integrity(profile_id)
            candidate = self._build_candidate(self.registry.directory(profile_id), profile)
            with self._prediction_lock:
                self._install(candidate)
        except Exception as exc:
            logger.exception("本地模型加载失败")
            missing = isinstance(exc, FileNotFoundError)
            message = (
                str(exc)
                if isinstance(exc, (ModelConfigurationError, LookupError, FileNotFoundError))
                else "模型加载失败，请检查模型文件、依赖及设备设置。"
            )
            with self._state_lock:
                values = {
                    "state": "missing" if missing else "error",
                    "error": message,
                    "profile_id": profile_id,
                    "device": self.settings.device,
                    "heatmap_supported": False,
                    "heatmap_method": None,
                }
                if profile is not None:
                    values.update(
                        {
                            "name": profile.name,
                            "origin": profile.origin,
                            "model_id": profile.model_id,
                            "revision": profile.revision,
                            "architecture": profile.architecture,
                            "parameters": profile.parameters,
                            "input_size": profile.input_size,
                            "input_width": profile.input_width,
                            "input_height": profile.input_height,
                            "labels": profile.labels,
                            "size_bytes": profile.size_bytes,
                            "uploaded_at": profile.created_at,
                            "reported_accuracy": MODEL_MANIFEST["reported_accuracy"]
                            if profile.origin == "builtin"
                            else None,
                            "source_url": MODEL_MANIFEST["source_url"]
                            if profile.origin == "builtin"
                            else "本地上传",
                            "license": MODEL_MANIFEST["license"]
                            if profile.origin == "builtin"
                            else "未声明",
                        }
                    )
                else:
                    values.update(
                        {
                            "name": "无法读取已选模型",
                            "origin": "local",
                            "model_id": f"local/{profile_id}",
                            "revision": "unknown",
                            "architecture": "未知",
                            "parameters": 0,
                            "input_size": 0,
                            "input_width": 0,
                            "input_height": 0,
                            "size_bytes": 0,
                            "reported_accuracy": None,
                            "source_url": "本地上传",
                            "license": "未知",
                        }
                    )
                self._info = ModelInfo(**values)

    def activate(self, profile_id: str) -> ModelInfo:
        # Keep the current classifier available while building its replacement.
        with self._activation_lock, self._candidate_lock:
            profile = self.registry.get(profile_id)
            self.registry.verify_integrity(profile_id)
            candidate = self._build_candidate(self.registry.directory(profile_id), profile)
            with self._prediction_lock:
                # Persistence first: failure cannot replace the current in-memory model.
                try:
                    self.registry.set_active(profile_id)
                except Exception as exc:
                    raise ModelConfigurationError(
                        "无法保存模型选择；当前模型未改变，请检查数据目录权限和磁盘空间。"
                    ) from exc
                self._install(candidate)
                return self.info()

    def _inputs(self, image: Image.Image) -> dict:
        size = getattr(self._processor, "size", None)
        if (
            getattr(self._processor, "do_resize", False)
            and isinstance(size, dict)
            and "shortest_edge" in size
        ):
            scale = size["shortest_edge"] / min(image.size)
            if max(image.size) * scale > 1024:
                raise ModelConfigurationError(
                    "图像长宽比导致模型预处理尺寸超过 1024 像素；请先提供适合该模型的图像。"
                )
        elif not getattr(self._processor, "do_resize", False) and max(image.size) > 1024:
            raise ModelConfigurationError("当前模型不缩放输入，图像尺寸不能超过 1024 像素。")
        inputs = self._processor(images=image, return_tensors="pt")
        pixels = inputs.get("pixel_values")
        if (
            pixels is None
            or pixels.ndim != 4
            or pixels.shape[:2] != (1, 3)
            or any(not 1 <= size <= 1024 for size in pixels.shape[-2:])
        ):
            raise ModelConfigurationError("图像预处理输出尺寸无效或超过 1024 像素限制。")
        return {name: tensor.to(self.settings.device) for name, tensor in inputs.items()}

    def predict(self, image: Image.Image) -> tuple[list[Probability], float, ModelInfo]:
        with self._prediction_lock:
            self.require_ready()
            snapshot = self.info()
            torch = self._torch
            started = perf_counter()
            with torch.inference_mode():
                inputs = self._inputs(image)
                logits = self._model(**inputs).logits
                if logits.shape != (1, 4) or not bool(torch.isfinite(logits).all()):
                    raise RuntimeError("模型输出类别数量或数值异常。")
                scores = torch.softmax(logits.float(), dim=-1)[0].cpu().tolist()
                if self.settings.device == "cuda":
                    torch.cuda.synchronize()
            elapsed_ms = (perf_counter() - started) * 1000
            if not all(math.isfinite(score) and 0 <= score <= 1 for score in scores):
                raise RuntimeError("模型输出包含无效数值。")
            return (
                [
                    Probability(label=label, score=score)
                    for label, score in zip(snapshot.labels, scores, strict=True)
                ],
                elapsed_ms,
                snapshot,
            )

    def explain(self, image: Image.Image, target_label: TumorLabel) -> Image.Image:
        with self._prediction_lock:
            self.require_ready()
            snapshot = self.info()
            if target_label not in snapshot.labels:
                raise ValueError("热力图目标类别无效。")
            if not snapshot.heatmap_supported:
                raise ModelConfigurationError(
                    "当前模型使用裁剪或填充预处理，无法准确对齐原图；此模型不提供热力图。"
                )
            torch = self._torch
            captured = []
            hook = None
            try:
                if snapshot.heatmap_method == "Grad-CAM":
                    hook = self._model.vit.encoder.layer[-1].layernorm_before.register_forward_hook(
                        lambda _module, _arguments, output: captured.append(output)
                    )
                with torch.inference_mode(False), torch.enable_grad():
                    inputs = self._inputs(image)
                    inputs["pixel_values"].requires_grad_(True)
                    logits = self._model(**inputs).logits
                    if logits.shape != (1, 4) or not bool(torch.isfinite(logits).all()):
                        raise RuntimeError("模型输出异常，无法生成热力图。")
                    target = logits[0, snapshot.labels.index(target_label)]
                    if snapshot.heatmap_method == "Grad-CAM":
                        if len(captured) != 1:
                            raise RuntimeError("模型注意力层激活异常。")
                        activation = captured[0]
                        patch = self._model.config.patch_size
                        patch_height, patch_width = (
                            patch if isinstance(patch, (list, tuple)) else (patch, patch)
                        )
                        rows = inputs["pixel_values"].shape[-2] // patch_height
                        columns = inputs["pixel_values"].shape[-1] // patch_width
                        if activation.ndim != 3 or activation.shape[:2] != (1, rows * columns + 1):
                            raise ModelConfigurationError(
                                "ViT 图像分块与输入尺寸不一致，无法准确生成 Grad-CAM。"
                            )
                        gradients = torch.autograd.grad(
                            target, activation, retain_graph=False, create_graph=False
                        )[0]
                        weights = gradients[:, 1:, :].mean(dim=1, keepdim=True)
                        attribution = torch.relu(
                            (activation[:, 1:, :] * weights).sum(dim=-1)
                        ).reshape(rows, columns)
                    else:
                        # Real input derivative, not a synthetic edge map or a purported Grad-CAM.
                        gradients = torch.autograd.grad(
                            target, inputs["pixel_values"], retain_graph=False, create_graph=False
                        )[0]
                        attribution = gradients[0].abs().mean(dim=0)
                    attribution = attribution.detach()
                    if not bool(torch.isfinite(attribution).all()):
                        raise RuntimeError("模型梯度包含无效数值，无法生成热力图。")
                    peak = float(attribution.max())
                    if peak > 0:
                        attribution = attribution / peak
                    width, height = int(attribution.shape[1]), int(attribution.shape[0])
                    pixels = bytes(
                        attribution.mul(255).round().to(torch.uint8).cpu().flatten().tolist()
                    )
                heat = Image.frombytes("L", (width, height), pixels)
                try:
                    resized = heat.resize(image.size, Image.Resampling.BILINEAR)
                    try:
                        palettes = (
                            [round(89 + 166 * value / 255) for value in range(256)],
                            [round(36 + 179 * (value / 255) ** 2) for value in range(256)],
                            [round(181 * (1 - value / 255)) for value in range(256)],
                            [round(192 * value / 255) for value in range(256)],
                        )
                        channels = tuple(resized.point(palette) for palette in palettes)
                        try:
                            return Image.merge("RGBA", channels)
                        finally:
                            for channel in channels:
                                channel.close()
                    finally:
                        resized.close()
                finally:
                    heat.close()
            finally:
                if hook is not None:
                    hook.remove()
                captured.clear()
                # autograd.grad targets activations only; frozen parameters never accumulate .grad.
                self._model.zero_grad(set_to_none=True)
