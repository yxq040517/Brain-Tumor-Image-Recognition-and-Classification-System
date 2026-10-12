import asyncio
import struct
import zlib
from io import BytesIO

import pytest
from fastapi import HTTPException, UploadFile
from PIL import Image, PngImagePlugin
from starlette.datastructures import Headers

from app.images import decode_raster, read_upload
from app.settings import MAX_UPLOAD_BYTES


def png_bytes(image: Image.Image, **options) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG", **options)
    return output.getvalue()


def test_orientation_is_applied_and_metadata_cannot_survive_normalization():
    with Image.new("RGBA", (64, 32), (0, 0, 0, 0)) as source:
        source.putpixel((0, 31), (255, 0, 0, 255))
        exif = Image.Exif()
        exif[274] = 6
        exif[270] = "患者身份信息"
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("patient", "患者身份信息")
        original = png_bytes(source, exif=exif, pnginfo=metadata)
    normalized = decode_raster(original)
    try:
        assert normalized.size == (32, 64)
        assert normalized.mode == "RGB"
        assert normalized.getpixel((0, 0)) == (255, 0, 0)
        with Image.open(BytesIO(png_bytes(normalized))) as persisted:
            assert not persisted.getexif()
            assert not persisted.info
    finally:
        normalized.close()


def test_animation_is_rejected_instead_of_silently_classifying_first_frame():
    with Image.new("RGB", (32, 32), "red") as first, Image.new("RGB", (32, 32), "blue") as second:
        original = png_bytes(first, save_all=True, append_images=[second], duration=100, loop=0)
    with pytest.raises(HTTPException) as captured:
        decode_raster(original)
    assert captured.value.status_code == 400


def test_oversized_dimensions_are_rejected_before_allocating_pixels():
    with Image.new("RGB", (32, 32)) as source:
        original = png_bytes(source)
    header = struct.pack(">II", 4001, 4000) + original[24:29]
    checksum = struct.pack(">I", zlib.crc32(b"IHDR" + header) & 0xFFFFFFFF)
    oversized = original[:16] + header + checksum + original[33:]
    with pytest.raises(HTTPException) as captured:
        decode_raster(oversized)
    assert captured.value.status_code == 413


def test_truncated_raster_is_not_accepted_by_header_identification_alone():
    with Image.new("RGB", (32, 32)) as source:
        original = png_bytes(source)
    with pytest.raises(HTTPException) as captured:
        decode_raster(original[: len(original) // 2])
    assert captured.value.status_code == 400


def test_upload_limit_accepts_exact_boundary_but_rejects_the_next_byte():
    async def read(data: bytes) -> bytes:
        upload = UploadFile(
            file=BytesIO(data),
            filename="slice.png",
            headers=Headers({"content-type": "image/png"}),
        )
        try:
            return await read_upload(upload)
        finally:
            await upload.close()

    exact = b"x" * MAX_UPLOAD_BYTES
    assert asyncio.run(read(exact)) == exact
    with pytest.raises(HTTPException) as captured:
        asyncio.run(read(exact + b"x"))
    assert captured.value.status_code == 413
