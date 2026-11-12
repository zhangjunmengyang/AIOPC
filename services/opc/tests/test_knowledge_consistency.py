import base64
import io
import json
import os
from pathlib import Path

import httpx
import pytest
from docx import Document
from PIL import Image

from aiopc.knowledge import Knowledge
from aiopc.media.image import ImageError
from aiopc.server import Workspace
from aiopc.space import SpaceCatalog


def test_catalog_tolerates_source_removed_after_directory_scan(tmp_path, monkeypatch):
    source = tmp_path / "removed.md"
    survivor = tmp_path / "kept.md"
    source.write_text("removed", encoding="utf-8")
    survivor.write_text("still available", encoding="utf-8")
    actual_scandir = os.scandir

    def scan_then_remove(directory):
        with actual_scandir(directory) as iterator:
            entries = list(iterator)
        source.unlink(missing_ok=True)
        return entries

    monkeypatch.setattr("aiopc.space.os.scandir", scan_then_remove)
    items = SpaceCatalog(tmp_path).files()["items"]
    assert [item["name"] for item in items] == [survivor.name]


def test_batch_import_cleans_partial_write_and_preserves_existing_files(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    knowledge = Knowledge(tmp_path / "home", root)
    existing = knowledge.import_file("good.md", b"existing document")
    actual_open = Path.open

    class FailingWriter:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            self.stream.__enter__()
            return self

        def __exit__(self, *args):
            return self.stream.__exit__(*args)

        def write(self, data):
            self.stream.write(data[:2])
            raise OSError("simulated disk full after partial write")

    def open_with_partial_failure(path, mode="r", *args, **kwargs):
        stream = actual_open(path, mode, *args, **kwargs)
        return FailingWriter(stream) if path.name == "partial.md" and mode == "xb" else stream

    monkeypatch.setattr(Path, "open", open_with_partial_failure)
    with pytest.raises(ValueError, match="导入失败"):
        knowledge.import_files([("good.md", b"new document"), ("partial.md", b"partial document")])
    assert existing.read_bytes() == b"existing document"
    assert {item.name for item in existing.parent.iterdir()} == {existing.name, existing.name + ".metadata.md"}


async def test_generation_accepts_only_live_extracted_images_from_its_project(tmp_path):
    home, root, other_root = tmp_path / "home", tmp_path / "project", tmp_path / "other"
    root.mkdir()
    other_root.mkdir()
    original = root / "picture.png"
    Image.new("RGB", (12, 12), "red").save(original)
    source = root / "illustrated.docx"
    document = Document()
    document.add_paragraph("活动海报参考图")
    document.add_picture(str(original))
    document.save(source)
    original.unlink()
    workspace = Workspace(home, root)
    extracted = next(item for item in workspace.knowledge.catalog()["items"] if item["extracted"])
    other = Workspace(home, other_root)
    # A valid image for one project must not authorize the same path in another.
    with pytest.raises(ImageError):
        other.images._reference(extracted["path"])

    (home / "media-profiles.json").write_text(json.dumps({"image": {
        "baseUrl": "https://images.example/v1", "model": "test", "authorization": "Bearer test-key",
    }}), encoding="utf-8")
    output = io.BytesIO()
    Image.new("RGB", (12, 12), "blue").save(output, format="PNG")
    calls = []

    async def handler(request):
        calls.append(request)
        assert request.url == "https://images.example/v1/images/edits"
        assert Path(extracted["path"]).read_bytes() in request.content
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(output.getvalue()).decode()}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        workspace.images.client = client
        generated = await workspace.images.generate("参考文档中的配图", reference_images=[extracted["path"]])
        assert generated["edited_from"] == [extracted["path"]]
        assert Path(generated["images"][0]).is_file()
        source.unlink()
        # Removing the owning document revokes permission, although cached bytes remain.
        with pytest.raises(ImageError):
            await workspace.images.generate("旧配图", reference_images=[extracted["path"]])
    assert len(calls) == 1
