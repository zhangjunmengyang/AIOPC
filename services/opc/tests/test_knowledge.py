
import pytest
from PIL import Image

from aiopc.knowledge import Knowledge


@pytest.fixture
def knowledge(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    return Knowledge(tmp_path / "home", workspace)


def document_and_image(knowledge):
    (knowledge.root / "knowledge").mkdir(exist_ok=True)
    (knowledge.root / "assets").mkdir(exist_ok=True)
    image = knowledge.root / "assets" / "photo.png"
    Image.new("RGB", (20, 20), "red").save(image)
    document = knowledge.root / "knowledge" / "guide.md"
    document.write_text("# 空间设计\n咖啡馆选用原木桌椅。\n![靠窗的阅读角](../assets/photo.png)\n", encoding="utf-8")
    return document, image


def test_reference_and_manual_annotations_preserve_source_links(knowledge):
    document, image = document_and_image(knowledge)
    assets = {i["path"]: i for i in knowledge.catalog()["items"]}
    assert assets[str(image)]["description"] == "靠窗的阅读角"
    assert assets[str(image)]["relations"][0]["path"] == str(document)
    result = knowledge.annotate(str(image), "窗边照片", "暖色咖啡店", [str(document)])
    assert result["alias"] == "窗边照片"
    assert {r["relation"] for r in result["relations"]} == {"referenced_by", "related_to"}
    assert result["related_paths"] == [str(document)]
    with pytest.raises(ValueError):
        knowledge.annotate(str(image), related_paths=["/etc/passwd"])


def test_parse_cache_invalidates_edits_and_removes_deleted_sources(knowledge, monkeypatch):
    from aiopc import knowledge as module
    actual, calls = module.parse_document, []

    def spy(*args):
        calls.append(args[0])
        return actual(*args)

    monkeypatch.setattr(module, "parse_document", spy)
    document, image = document_and_image(knowledge)
    knowledge.catalog()
    knowledge.catalog()
    assert calls == [document]
    document.write_text("# 改稿\n自然采光与舒适座椅。", encoding="utf-8")
    with knowledge.lock:
        _, sources, _ = knowledge._catalog()
    assert len(calls) == 2
    chunks = sources["knowledge/guide.md"]["chunks"]
    assert any("自然采光" in chunk["text"] for chunk in chunks)
    assert not any("原木桌椅" in chunk["text"] for chunk in chunks)
    document.unlink()
    result = knowledge.catalog()["items"]
    assert [a["path"] for a in result] == [str(image)]
    assert result[0]["relations"] == []


def test_import_does_not_overwrite_or_escape_workspace(knowledge, tmp_path):
    first = knowledge.import_file("../../plan.md", b"first")
    second = knowledge.import_file("plan.md", b"second")
    assert first.read_bytes() == b"first" and second.read_bytes() == b"second"
    assert first != second and second.is_relative_to(knowledge.root)
    with pytest.raises(ValueError):
        knowledge.import_file(".env", b"secret")
    other = Knowledge(tmp_path / "home", tmp_path / "other")
    other.root.mkdir()
    (other.root / "knowledge").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError):
        other.import_file("private.md", b"no")
    assert not (tmp_path / "imports").exists()


def test_extracted_image_only_accessible_with_its_live_source(knowledge, tmp_path):
    from docx import Document
    _document, image = document_and_image(knowledge)
    source = knowledge.root / "knowledge" / "illustrated.docx"
    doc = Document()
    doc.add_paragraph("设计方案中的咖啡店配图")
    doc.add_picture(str(image))
    doc.save(source)
    assets = knowledge.catalog()["items"]
    extracted = next(a for a in assets if a["extracted"])
    assert knowledge.resolve(extracted["path"]).is_file()
    assert extracted["relations"][0]["path"] == str(source)
    other = Knowledge(tmp_path / "home", tmp_path / "other")
    with pytest.raises(ValueError):
        other.resolve(extracted["path"])
    source.unlink()
    with pytest.raises(ValueError):
        knowledge.resolve(extracted["path"])


def test_generation_intent_and_derived_relationship_are_searchable(knowledge):
    _, reference = document_and_image(knowledge)
    output = knowledge.root / "assets" / "generated.png"
    Image.new("RGB", (10, 10)).save(output)
    knowledge.record_generation([str(output)], "根据品牌图制作春季活动海报", [str(reference)])
    assets = knowledge.catalog()
    result = next(a for a in assets["items"] if a["path"] == str(output))
    assert result["description"].startswith("生成要求：")
    assert result["relations"][0]["relation"] == "derived_from"
    assert "春季活动海报" in output.with_suffix(".md").read_text()


def test_imported_rst_and_markdown_are_in_catalog(knowledge):
    for suffix in [".rst", ".markdown", ".htm"]:
        path = knowledge.import_file("example" + suffix, b"knowledge text")
        assert any(item["path"] == str(path) for item in knowledge.catalog()["items"])


def test_markdown_image_filenames_with_spaces_parentheses_and_reference_links(knowledge):
    document, image = document_and_image(knowledge)
    renamed = image.with_name("plan photo (1).png")
    image.rename(renamed)
    document.write_text('![窗边方案](<../assets/plan photo (1).png>)\n\n![同一配图][photo]\n\n'
                        '[photo]: ../assets/plan%20photo%20%281%29.png\n', encoding="utf-8")
    assets = {item["path"]: item for item in knowledge.catalog()["items"]}
    assert assets[str(renamed)]["description"] == "窗边方案"
    assert assets[str(document)]["relations"][0]["path"] == str(renamed)


def test_invalid_batch_import_leaves_no_partial_files(knowledge):
    with pytest.raises(ValueError, match="不支持"):
        knowledge.import_files([("good.md", b"safe"), ("bad.exe", b"invalid")])
    assert not (knowledge.root / "knowledge").exists()


def test_deleted_manual_relationship_is_removed_from_editable_paths(knowledge):
    document, image = document_and_image(knowledge)
    knowledge.annotate(str(image), related_paths=[str(document)])
    document.unlink()
    assert knowledge.catalog()["items"][0]["related_paths"] == []
