import unicodedata
import warnings
from io import BytesIO

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

from .settings import MAX_IMAGE_PIXELS, MAX_UPLOAD_BYTES

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
SUPPORTED_FORMATS = {"PNG", "JPEG", "WEBP"}
SUPPORTED_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}


def safe_filename(filename: str | None) -> str:
    name = (filename or "影像.png").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(
        character
        for character in name
        if not unicodedata.category(character).startswith("C") and character not in '<>:"/\\|?*'
    )
    return name.strip(" .")[:180].rstrip(" .") or "影像.png"


async def read_upload(upload: UploadFile) -> bytes:
    if upload.content_type not in SUPPORTED_MIME_TYPES:
        raise HTTPException(415, "仅支持 PNG、JPEG 或 WebP 格式的二维 MRI 切片。")
    contents = bytearray()
    while chunk := await upload.read(64 * 1024):
        if len(contents) + len(chunk) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "文件超过 10 MiB 上限，请使用较小的二维切片。")
        contents.extend(chunk)
    if not contents:
        raise HTTPException(400, "影像文件为空，请重新选择文件。")
    return bytes(contents)


def decode_raster(contents: bytes) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(contents)) as source:
                if source.format not in SUPPORTED_FORMATS:
                    raise HTTPException(415, "影像实际格式不受支持，仅支持 PNG、JPEG 或 WebP。")
                if getattr(source, "is_animated", False) or getattr(source, "n_frames", 1) != 1:
                    raise HTTPException(400, "不支持动画或多帧影像，请上传单张二维 MRI 切片。")
                width, height = source.size
                if width < 32 or height < 32:
                    raise HTTPException(400, "影像宽高均须至少为 32 像素。")
                if width * height > MAX_IMAGE_PIXELS:
                    raise HTTPException(413, "影像超过 1600 万像素上限，请缩小后重试。")
                source.verify()
            with Image.open(BytesIO(contents)) as source:
                source.load()
                oriented = ImageOps.exif_transpose(source)
                try:
                    normalized = oriented.convert("RGB")
                finally:
                    if oriented is not source:
                        oriented.close()
                normalized.info.clear()
                return normalized
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise HTTPException(413, "影像超过安全像素上限，无法处理。") from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError) as exc:
        raise HTTPException(400, "无法解码影像：文件可能损坏、截断或并非真实图像。") from exc
