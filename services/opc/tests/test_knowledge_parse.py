import io
import zipfile
from pathlib import Path

import pytest
from docx import Document
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

from aiopc import knowledge_parse
from aiopc.knowledge_parse import parse_document


def png() -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (12, 8), "blue").save(stream, "PNG")
    return stream.getvalue()


def parse(tmp_path, name, data):
    source = tmp_path / name
    source.write_bytes(data if isinstance(data, bytes) else data.encode())
    return parse_document(source, name, tmp_path / "media")


def pdf(*, pages=1, text="Revenue 20", image=True, password=None):
    writer = PdfWriter()
    for _ in range(pages):
        page = writer.add_blank_page(width=200, height=200)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                                 NameObject("/Subtype"): NameObject("/Type1"),
                                 NameObject("/BaseFont"): NameObject("/Helvetica")})
        resources = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        commands = f"BT /F1 12 Tf 10 20 Td ({text}) Tj ET\n" if text else ""
        if image:
            picture = DecodedStreamObject()
            picture.set_data(bytes([255, 0, 0]) * 4)
            picture.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"),
                            NameObject("/Width"): NumberObject(2), NameObject("/Height"): NumberObject(2),
                            NameObject("/ColorSpace"): NameObject("/DeviceRGB"), NameObject("/BitsPerComponent"): NumberObject(8)})
            resources[NameObject("/XObject")] = DictionaryObject({NameObject("/Image1"): writer._add_object(picture)})
            commands += "q 30 0 0 30 0 0 cm /Image1 Do Q"
        contents = DecodedStreamObject()
        contents.set_data(commands.encode())
        page[NameObject("/Contents")] = writer._add_object(contents)
        page[NameObject("/Resources")] = resources
    if password:
        writer.encrypt(password)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


@pytest.mark.parametrize("suffix", ["md", "txt", "rst", "json"])
def test_plain_text_keeps_source_lines_and_markdown_images(tmp_path, suffix):
    content = '{"产品":"AIOPC"}' if suffix == "json" else "# 产品\n正文\n![封面](images/cover.png)\n"
    result = parse(tmp_path, f"notes.{suffix}", content)
    assert result["chunks"][0]["text"] == content.strip()
    assert "第 1" in result["chunks"][0]["locator"]
    assert result["images"] == [] and result["warnings"] == []


def test_html_keeps_visible_text_and_alt_but_not_scripts(tmp_path):
    result = parse(tmp_path, "page.html", '<h1>产品</h1><script>secret()</script><style>.x{}</style><p>正文 &amp; 图片</p><img alt="蓝色标志" src="https://invalid/image.png">')
    text = "\n".join(chunk["text"] for chunk in result["chunks"])
    assert "产品" in text and "正文 & 图片" in text and "蓝色标志" in text
    assert "secret" not in text and ".x" not in text and not result["images"]


def test_csv_respects_quoted_cells_and_json_errors_keep_searchable_text(tmp_path):
    result = parse(tmp_path, "data.csv", 'name,description\nitem,"first, second"\n')
    assert result["chunks"][1]["text"] == "item | first, second"
    assert "记录 2" in result["chunks"][1]["locator"]
    malformed = parse(tmp_path, "bad.json", '{"unfinished":')
    assert malformed["chunks"] and any("JSON 格式无效" in warning for warning in malformed["warnings"])


def test_pdf_text_and_images_have_page_provenance(tmp_path):
    result = parse(tmp_path, "sales.pdf", pdf(pages=2))
    assert [chunk["locator"] for chunk in result["chunks"]] == ["第 1 页", "第 2 页"]
    assert all("Revenue 20" in chunk["text"] for chunk in result["chunks"])
    assert len(result["images"]) == 2
    assert result["images"][0]["path"] == result["images"][1]["path"]
    assert result["images"][0]["locator"] != result["images"][1]["locator"]
    assert "同页文字：Revenue 20" in result["images"][0]["description"]
    with Image.open(result["images"][0]["path"]) as image:
        assert image.size == (2, 2)
    assert not result["warnings"]


def test_scan_pdf_is_explicitly_incomplete_and_does_not_invent_caption(tmp_path):
    result = parse(tmp_path, "scan.pdf", pdf(text=""))
    assert result["chunks"] == [] and len(result["images"]) == 1
    assert result["images"][0]["description"] == ""
    assert any("尚未进行 OCR" in warning for warning in result["warnings"])


def test_pdf_password_and_broken_documents_return_warnings(tmp_path):
    encrypted = parse(tmp_path, "encrypted.pdf", pdf(password="secret"))
    assert not encrypted["chunks"] and any("密码" in warning for warning in encrypted["warnings"])
    damaged = parse(tmp_path, "broken.pdf", b"%PDF-1.7 broken")
    assert not damaged["chunks"] and damaged["warnings"]


def test_docx_preserves_body_table_images_and_verifiable_alt(tmp_path):
    document = Document()
    document.add_paragraph("产品说明")
    paragraph = document.add_paragraph()
    paragraph.add_run().add_picture(io.BytesIO(png()))
    paragraph._p.xpath(".//wp:docPr")[0].set("descr", "蓝色产品图")
    document.add_paragraph("图 1 产品正面")
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "价格"
    table.cell(0, 1).text = "20"
    table.cell(0, 1).paragraphs[0].add_run().add_picture(io.BytesIO(png()))
    document.sections[0].header.paragraphs[0].text = "品牌页眉"
    stream = io.BytesIO()
    document.save(stream)
    result = parse(tmp_path, "product.docx", stream.getvalue())
    assert any(chunk["text"] == "价格 | 20" and "表格 1 · 行 1" in chunk["locator"] for chunk in result["chunks"])
    assert any("品牌页眉" in chunk["text"] for chunk in result["chunks"])
    assert len(result["images"]) == 2
    assert "蓝色产品图" in result["images"][0]["description"]
    assert "图 1 产品正面" in result["images"][0]["description"]
    assert "段落 2" in result["images"][0]["locator"]
    assert "表格 1" in result["images"][1]["locator"]
    assert result["images"][0]["path"] == result["images"][1]["path"]
    assert not result["warnings"]


def test_limits_report_partial_results(tmp_path, monkeypatch):
    monkeypatch.setattr(knowledge_parse, "MAX_PAGES", 1)
    result = parse(tmp_path, "many.pdf", pdf(pages=2))
    assert len(result["chunks"]) == 1 and any("仅处理前 1 页" in warning for warning in result["warnings"])
    monkeypatch.setattr(knowledge_parse, "MAX_IMAGES", 0)
    result = parse(tmp_path, "no-images.pdf", pdf())
    assert not result["images"] and result["chunks"] and any("图片达到" in warning for warning in result["warnings"])
    monkeypatch.setattr(knowledge_parse, "MAX_TEXT_CHARS", 8)
    result = parse(tmp_path, "long.txt", "abcdefghijklmnop")
    assert sum(len(chunk["text"]) for chunk in result["chunks"]) <= 8 and result["warnings"]
    monkeypatch.setattr(knowledge_parse, "MAX_FILE_BYTES", 5)
    result = parse(tmp_path, "large.txt", "abcdef")
    assert not result["chunks"] and result["warnings"]


def test_docx_archive_limits_and_image_pixel_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(knowledge_parse, "MAX_ARCHIVE_BYTES", 10)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", "x" * 100)
    result = parse(tmp_path, "huge.docx", stream.getvalue())
    assert not result["chunks"] and any("超过上限" in warning for warning in result["warnings"])
    monkeypatch.setattr(knowledge_parse, "MAX_IMAGE_PIXELS", 1)
    result = parse(tmp_path, "big-image.pdf", pdf())
    assert result["chunks"] and not result["images"] and any("图片像素" in warning for warning in result["warnings"])


def test_output_image_symlink_cannot_escape_media_root(tmp_path):
    result = parse(tmp_path, "first.pdf", pdf())
    image = Path(result["images"][0]["path"])
    image.unlink()
    outside = tmp_path / "outside.txt"
    outside.write_text("keep me")
    image.symlink_to(outside)
    retry = parse(tmp_path, "second.pdf", pdf())
    assert not retry["images"] and any("符号链接" in warning for warning in retry["warnings"])
    assert outside.read_text() == "keep me"


def test_missing_input_does_not_raise(tmp_path):
    result = parse_document(tmp_path / "missing.pdf", "missing.pdf", tmp_path / "media")
    assert result["chunks"] == [] and result["images"] == [] and result["warnings"]


def test_markdown_frontmatter_is_not_searchable_and_source_line_numbers_are_preserved(tmp_path):
    result = parse(tmp_path, "note.md", "---\nscope: company\n---\n原文标题\n")
    assert result["chunks"] == [{"text": "原文标题", "locator": "第 4–4 行"}]


def test_markitdown_extracts_local_workbook_and_slides(tmp_path):
    from openpyxl import Workbook
    from pptx import Presentation

    workbook = Workbook()
    workbook.active.append(["业务数据", "订阅收入"])
    workbook.active.append(["本月", 42])
    workbook_bytes = io.BytesIO()
    workbook.save(workbook_bytes)
    workbook_data = parse(tmp_path, "data.xlsx", workbook_bytes.getvalue())
    assert "订阅收入" in workbook_data["chunks"][0]["text"]
    assert "42" in workbook_data["chunks"][0]["text"]
    assert not workbook_data["warnings"]

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[0])
    slide.shapes.title.text = "品牌定位"
    slides_bytes = io.BytesIO()
    presentation.save(slides_bytes)
    slides_data = parse(tmp_path, "slides.pptx", slides_bytes.getvalue())
    assert "品牌定位" in slides_data["chunks"][0]["text"]
    assert not slides_data["warnings"]
