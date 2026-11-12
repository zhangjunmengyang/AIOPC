"""Bounded local document extraction. Descriptions contain source text, never guesses."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import warnings
import zipfile
from html.parser import HTMLParser
from pathlib import Path

from PIL import Image

from aiopc.knowledge_markdown import MARKDOWN_SUFFIXES, split_markdown

MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_PAGES = 200
MAX_IMAGES = 100
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 25_000_000
MAX_MEDIA_BYTES = 64 * 1024 * 1024
MAX_TEXT_CHARS = 400_000
MAX_CHUNK_CHARS = 4_000
MAX_PDF_STREAM_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 5_000
_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_DRAWING = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_VML = "{urn:schemas-microsoft-com:vml}"


class _Result:
    def __init__(self, relative: str, media_root: Path):
        self.relative = relative
        self.media_root = media_root
        self.chunks: list[dict] = []
        self.images: list[dict] = []
        self.warnings: list[str] = []
        self.text_chars = 0
        self.media_bytes = 0
        self.image_attempts = 0

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)

    def chunk(self, text: str, locator: str) -> None:
        text = text.replace("\x00", "").strip()
        remaining = MAX_TEXT_CHARS - self.text_chars
        if len(text) > remaining:
            self.warn(f"文本达到 {MAX_TEXT_CHARS} 字符上限，后续内容未收录。")
        text = text[:max(0, remaining)]
        self.text_chars += len(text)
        while text:
            end = min(len(text), MAX_CHUNK_CHARS)
            if end < len(text):
                boundary = max(text.rfind("\n", end // 2, end), text.rfind(" ", end // 2, end))
                if boundary > 0:
                    end = boundary
            piece = text[:end].strip()
            if piece:
                self.chunks.append({"text": piece, "locator": locator})
            text = text[end:].lstrip()

    def image(self, data: bytes, name: str, description: str, locator: str) -> None:
        if len(data) > MAX_IMAGE_BYTES or self.media_bytes + len(data) > MAX_MEDIA_BYTES:
            self.warn(f"{locator}：图片数据超过提取上限，已跳过。")
            return
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as image:
                    if image.width * image.height > MAX_IMAGE_PIXELS:
                        raise ValueError("图片像素超过上限")
                    extension = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp", "GIF": "gif",
                                 "TIFF": "tif", "BMP": "bmp"}.get(image.format or "")
                    if extension is None:
                        raise ValueError("图片格式暂不支持")
                    image.verify()
            self.media_root.mkdir(parents=True, exist_ok=True)
            # Untrusted embedded filenames never become output paths. Repeated
            # occurrences share bytes but keep their individual source locators.
            destination = self.media_root / f"{hashlib.sha256(data).hexdigest()}.{extension}"
            if destination.is_symlink():
                raise ValueError("图片输出路径不能是符号链接")
            if not destination.exists():
                destination.write_bytes(data)
            self.media_bytes += len(data)
            self.images.append({"path": str(destination.resolve()), "name": name,
                                "description": description[:1200], "locator": locator})
        except Exception as exc:  # noqa: BLE001 - Isolate malformed images and optional decoder failures.
            self.warn(f"{locator}：图片未提取（{type(exc).__name__}：{str(exc)[:120]}）。")

    def finish(self) -> dict:
        return {"chunks": self.chunks, "images": self.images, "warnings": self.warnings}

    def take_image(self) -> bool:
        if self.image_attempts >= MAX_IMAGES:
            self.warn(f"图片达到 {MAX_IMAGES} 张处理上限，后续图片未提取。")
            return False
        self.image_attempts += 1
        return True


class _HTMLText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "noscript", "template"}:
            self.hidden += 1
        if self.hidden:
            return
        if tag in {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "section", "article"}:
            self.parts.append("\n")
        if tag in {"td", "th"}:
            self.parts.append("\t")
        if tag == "img":
            alt = dict(attrs).get("alt")
            if alt:
                self.parts.append(f"[图片替代文字：{alt}]")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript", "template"}:
            self.hidden = max(0, self.hidden - 1)
        elif not self.hidden and tag in {"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "section", "article"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def _decode(data: bytes, result: _Result) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = data.decode("gb18030")
            result.warn("文件不是 UTF-8，已按 GB18030 解码；如有乱码请转换为 UTF-8。")
            return text
        except UnicodeDecodeError:
            result.warn("文件含无法解码的字符，已用替代字符保留可读内容。")
            return data.decode("utf-8", errors="replace")


def _text_lines(text: str, result: _Result, prefix: str = "", line_offset: int = 0) -> None:
    start, size, group, number = line_offset + 1, 0, [], line_offset
    for number, line in enumerate(io.StringIO(text), line_offset + 1):
        line = line.rstrip("\r\n")
        if group and size + len(line) > MAX_CHUNK_CHARS:
            result.chunk("\n".join(group), f"{prefix}第 {start}–{number - 1} 行")
            start, size, group = number, 0, []
        group.append(line)
        size += len(line) + 1
        if result.text_chars >= MAX_TEXT_CHARS:
            result.warn(f"文本达到 {MAX_TEXT_CHARS} 字符上限，后续内容未收录。")
            return
    if group:
        result.chunk("\n".join(group), f"{prefix}第 {start}–{number} 行")


def _plain(data: bytes, suffix: str, result: _Result) -> None:
    text = _decode(data, result)
    if suffix in MARKDOWN_SUFFIXES:
        _, body, offset = split_markdown(text)
        _text_lines(body, result, line_offset=offset)
    elif suffix in {".html", ".htm"}:
        parser = _HTMLText()
        parser.feed(text)
        parser.close()
        _text_lines("".join(parser.parts), result, "HTML 提取文字 · ")
    elif suffix == ".csv":
        try:
            dialect = csv.Sniffer().sniff(text[:4096])
        except csv.Error:
            dialect = csv.excel
        reader = csv.reader(io.StringIO(text), dialect)
        for number, row in enumerate(reader, 1):
            result.chunk(" | ".join(row), f"记录 {number}（截至第 {reader.line_num} 行）")
            if result.text_chars >= MAX_TEXT_CHARS:
                result.warn(f"文本达到 {MAX_TEXT_CHARS} 字符上限，后续内容未收录。")
                break
    else:
        if suffix == ".json":
            try:
                json.loads(text)
            except (ValueError, RecursionError):
                result.warn("JSON 格式无效，已按原始文本收录。")
        # Markdown image references remain in the text for the knowledge layer.
        _text_lines(text, result)


def _pdf(data: bytes, result: _Result) -> None:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data), strict=False)
    if reader.is_encrypted and not reader.decrypt(""):
        result.warn("PDF 需要密码，未提取内容。")
        return
    total = len(reader.pages)
    if total > MAX_PAGES:
        result.warn(f"PDF 共 {total} 页，仅处理前 {MAX_PAGES} 页。")
    for index in range(min(total, MAX_PAGES)):
        locator = f"第 {index + 1} 页"
        page = None
        try:
            page = reader.pages[index]
            stream = page.get_contents()
            if stream is not None and len(stream.get_data()) > MAX_PDF_STREAM_BYTES:
                result.warn(f"{locator}：解压后的页面内容超过上限，已跳过。")
                continue
            text = page.extract_text() or ""
            result.chunk(text, locator)
            if not text.strip():
                result.warn(f"{locator}：没有可提取文字，可能为空白页、扫描件或矢量内容；尚未进行 OCR。")
        except Exception as exc:  # noqa: BLE001 - Keep other pages when a third-party parser rejects one page.
            result.warn(f"{locator}：文字提取失败（{type(exc).__name__}），仍尝试提取图片。")
            text = ""
        if page is None:
            continue
        try:
            for number, key in enumerate(page.images.keys(), 1):
                if not result.take_image():
                    break
                image_locator = f"{locator} · 图片 {number}"
                try:
                    image = page.images[key]
                    description = f"同页文字：{text.strip()[:1000]}" if text.strip() else ""
                    result.image(image.data, f"{Path(result.relative).stem} · {locator} · {image.name}", description, image_locator)
                except Exception as exc:  # noqa: BLE001 - One broken embedded object must not discard other images.
                    result.warn(f"{image_locator}：提取失败（{type(exc).__name__}）。")
        except Exception as exc:  # noqa: BLE001 - Broken image trees must not discard extracted text.
            result.warn(f"{locator}：无法枚举图片（{type(exc).__name__}）。")


def _check_office_archive(data: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ARCHIVE_ENTRIES or sum(item.file_size for item in entries) > MAX_ARCHIVE_BYTES:
            raise ValueError("Office 文件解压后的文件数量或总大小超过上限")
        if any(item.file_size > MAX_IMAGE_BYTES for item in entries):
            raise ValueError("Office 内部文件超过大小上限")


def _paragraph_images(paragraph, part, locator: str, nearby: str, result: _Result) -> None:
    elements = [node for node in paragraph._p.iter() if node.tag in {_DRAWING + "blip", _VML + "imagedata"}]
    for number, node in enumerate(elements, 1):
        if not result.take_image():
            break
        image_locator = f"{locator} · 图片 {number}"
        relation_id = node.get(_REL + "embed") or node.get(_REL + "id")
        if not relation_id:
            result.warn(f"{image_locator}：外部链接图片未下载。")
            continue
        try:
            relation = part.rels[relation_id]
            if relation.is_external:
                result.warn(f"{image_locator}：外部链接图片未下载。")
                continue
            descriptions = []
            for ancestor in node.iterancestors():
                if ancestor.tag == _WORD + "drawing" or ancestor.tag == _WORD + "pict":
                    for item in ancestor.iter():
                        for key in ("descr", "title", "alt"):
                            value = item.get(key)
                            if value and value not in descriptions:
                                descriptions.append(value)
                    break
            context = paragraph.text.strip() or nearby.strip()
            description = "；".join(descriptions)
            if context:
                description += ("\n" if description else "") + f"文档上下文：{context[:800]}"
            image = relation.target_part
            result.image(image.blob, f"{Path(result.relative).stem} · {Path(str(image.partname)).name}",
                         description, image_locator)
        except Exception as exc:  # noqa: BLE001 - A missing/unsupported OOXML image part is a partial failure.
            result.warn(f"{image_locator}：图片关系读取失败（{type(exc).__name__}）。")


def _docx_blocks(container, prefix: str, result: _Result) -> None:
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    root = container._element
    element = root.body if hasattr(root, "body") else root
    blocks = list(element.iterchildren())
    paragraphs, tables, previous_text = 0, 0, ""
    for block_index, block in enumerate(blocks):
        if block.tag == _WORD + "p":
            paragraphs += 1
            paragraph = Paragraph(block, container)
            locator = f"{prefix}段落 {paragraphs}"
            result.chunk(paragraph.text, locator)
            following = ""
            if block_index + 1 < len(blocks) and blocks[block_index + 1].tag == _WORD + "p":
                following = Paragraph(blocks[block_index + 1], container).text
            nearby = "\n".join(value for value in (previous_text, following) if value.strip())
            _paragraph_images(paragraph, container.part, locator, nearby, result)
            if paragraph.text.strip():
                previous_text = paragraph.text
        elif block.tag == _WORD + "tbl":
            tables += 1
            table = Table(block, container)
            locator = f"{prefix}表格 {tables}"
            for row_number, row in enumerate(table.rows, 1):
                seen, cells = set(), []
                for cell in row.cells:
                    if cell._tc not in seen:
                        seen.add(cell._tc)
                        cells.append(" ".join(node.text or "" for node in cell._tc.iter(_WORD + "t")))
                result.chunk(" | ".join(cells), f"{locator} · 行 {row_number}")
            for number, paragraph_node in enumerate(block.iter(_WORD + "p"), 1):
                paragraph = Paragraph(paragraph_node, container)
                _paragraph_images(paragraph, container.part, f"{locator} · 段落 {number}", "", result)


def _docx(data: bytes, result: _Result) -> None:
    from docx import Document

    _check_office_archive(data)
    document = Document(io.BytesIO(data))
    _docx_blocks(document, "", result)
    seen = set()
    for section_number, section in enumerate(document.sections, 1):
        for label, container in (("页眉", section.header), ("页脚", section.footer),
                                 ("首页页眉", section.first_page_header), ("首页页脚", section.first_page_footer),
                                 ("偶数页页眉", section.even_page_header), ("偶数页页脚", section.even_page_footer)):
            if container.is_linked_to_previous:
                continue
            identity = str(container.part.partname)
            if identity not in seen:
                seen.add(identity)
                _docx_blocks(container, f"第 {section_number} 节{label} · ", result)


def _office(data: bytes, suffix: str, result: _Result) -> None:
    from markitdown import MarkItDown, StreamInfo

    _check_office_archive(data)
    converted = MarkItDown(enable_plugins=False).convert_stream(io.BytesIO(data), stream_info=StreamInfo(extension=suffix))
    _text_lines(converted.markdown, result, "转换后 Markdown · ")


def parse_document(path: Path, relative: str, media_root: Path) -> dict:
    """Extract text and image occurrences; partial failures are returned as warnings.

    ``locator`` is a human-readable page, paragraph, table-row or source-line
    location. DOCX has no reliable rendered page number without a layout engine.
    Image paths are absolute, content-addressed files under ``media_root``.
    """
    result = _Result(relative, media_root)
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            result.warn(f"文件超过 {MAX_FILE_BYTES // (1024 * 1024)} MiB 上限，未解析。")
            return result.finish()
        with path.open("rb") as stream:
            data = stream.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            result.warn("文件读取时超过大小上限，未解析。")
            return result.finish()
        suffix = path.suffix.lower()
        if suffix == ".pdf":
            _pdf(data, result)
        elif suffix == ".docx":
            _docx(data, result)
        elif suffix in {".pptx", ".xlsx"}:
            _office(data, suffix, result)
        elif suffix in {".md", ".markdown", ".txt", ".csv", ".rst", ".html", ".htm", ".json"}:
            _plain(data, suffix, result)
        else:
            result.warn(f"暂不支持解析 {suffix or '无扩展名'} 文件。")
    except Exception as exc:  # noqa: BLE001 - Public ingestion boundary: one bad file cannot abort the knowledge library.
        result.warn(f"解析未完成（{type(exc).__name__}：{str(exc)[:160]}），已保留成功提取的内容。")
    return result.finish()
