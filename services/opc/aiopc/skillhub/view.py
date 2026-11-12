"""Generate Markdown documents for the skills collection."""

import yaml

from .manifest import SkillRecord


def render_index(skill: SkillRecord, source: str) -> str:
    names = list(dict.fromkeys([skill.title, *(name for items in skill.names.values() for name in items)]))
    descriptions = list(dict.fromkeys(text for items in skill.descriptions.values() for text in items))
    metadata = {
        "id": skill.id, "title": skill.title, "aliases": names, "scope": "skills", "kind": "skill",
        "names": {lang: list(values) for lang, values in skill.names.items()},
        "descriptions": {lang: list(values) for lang, values in skill.descriptions.items()},
        "categories": list(skill.categories), "has_scripts": skill.has_scripts,
        "source_url": skill.source_url, "commit": skill.commit, "license": skill.license,
        "content_hash": skill.content_hash, "specification": skill.specification.status, "scan": skill.scan.status,
    }
    # qmd 的正文检索也能命中目录补充的中文名称与描述。
    heading = "\n\n".join([*names, *descriptions])
    frontmatter = yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False)
    return f"---\n{frontmatter}---\n\n{heading}\n\n{source.rstrip()}\n"
