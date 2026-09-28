"""Tests for the waiver YAML loader + markdown renderer.

Spec: spec_pentacle_mobile_e2e_telemetry_flows_2026_05_13 Stage 1.3.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from waivers import (
    TABLE_HEADER,
    TABLE_SEPARATOR,
    load_waivers,
    render_waivers_md,
)


def test_default_yaml_renders_to_expected_markdown_table(tmp_path, monkeypatch) -> None:
    p = tmp_path / "waivers.yaml"
    p.write_text("waivers: []\n")
    monkeypatch.setattr("waivers.DEFAULT_WAIVERS_PATH", p)
    rendered = render_waivers_md()
    assert rendered == TABLE_HEADER + "\n" + TABLE_SEPARATOR + "\n"
    assert rendered.endswith("\n")


def test_load_waivers_returns_synthetic_row(tmp_path, monkeypatch) -> None:
    p = tmp_path / "waivers.yaml"
    p.write_text("waivers: []\n")
    monkeypatch.setattr("waivers.DEFAULT_WAIVERS_PATH", p)
    waivers = load_waivers()
    assert isinstance(waivers, list)
    assert waivers == []


def test_empty_waivers_yaml_renders_header_only(tmp_path: Path) -> None:
    p = tmp_path / "waivers.yaml"
    p.write_text("waivers: []\n", encoding="utf-8")
    rendered = render_waivers_md(p)
    assert rendered == TABLE_HEADER + "\n" + TABLE_SEPARATOR + "\n"


def test_missing_waivers_key_treated_as_empty(tmp_path: Path) -> None:
    p = tmp_path / "waivers.yaml"
    p.write_text("# nothing here\n", encoding="utf-8")
    rendered = render_waivers_md(p)
    assert rendered == TABLE_HEADER + "\n" + TABLE_SEPARATOR + "\n"


def test_missing_required_field_raises(tmp_path: Path) -> None:
    p = tmp_path / "waivers.yaml"
    p.write_text(
        textwrap.dedent(
            """\
            waivers:
              - scenario_id: foo
                reason: bar
                tracking_spec: baz
                granted_on: 2026-01-01
            """
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError):
        load_waivers(p)


def test_multi_row_render(tmp_path: Path) -> None:
    p = tmp_path / "waivers.yaml"
    p.write_text(
        textwrap.dedent(
            """\
            waivers:
              - scenario_id: a
                reason: r1
                tracking_spec: spec_a
                granted_on: 2026-01-01
                expires_on: 2026-01-31
              - scenario_id: b
                reason: r2
                tracking_spec: spec_b
                granted_on: 2026-02-01
                expires_on: 2026-02-28
            """
        ),
        encoding="utf-8",
    )
    rendered = render_waivers_md(p)
    assert "| `a` | `r1` | `spec_a` | `2026-01-01` | `2026-01-31` |" in rendered
    assert "| `b` | `r2` | `spec_b` | `2026-02-01` | `2026-02-28` |" in rendered
