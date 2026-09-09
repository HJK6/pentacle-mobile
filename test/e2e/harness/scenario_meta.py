from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TypedDict


VALID_TARGETS = frozenset({"device", "simulator"})
VALID_REQUIRES = frozenset(
    {"biometric_hardware", "real_network", "real_keyboard", "claude"}
)
SKIPPED_EXIT_CODE = 3


class ScenarioMeta(TypedDict, total=False):
    target_compat: set[str]
    requires: list[str]


@dataclass(frozen=True)
class NormalizedScenarioMeta:
    target_compat: frozenset[str]
    requires: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "target_compat": sorted(self.target_compat),
            "requires": list(self.requires),
        }


def validate_scenario_meta(raw: Any, *, scenario_name: str) -> NormalizedScenarioMeta:
    if raw is None:
        raise ValueError(f"scenario {scenario_name} missing SCENARIO_META.target_compat")
    if not isinstance(raw, dict):
        raise ValueError(f"scenario {scenario_name} SCENARIO_META must be a dict")
    if "target_compat" not in raw:
        raise ValueError(f"scenario {scenario_name} missing SCENARIO_META.target_compat")

    target_raw = raw.get("target_compat")
    if not isinstance(target_raw, (set, frozenset, list, tuple)):
        raise ValueError(f"scenario {scenario_name} SCENARIO_META.target_compat must be a set/list/tuple")
    target_compat = frozenset(str(item) for item in target_raw)
    if not target_compat:
        raise ValueError(f"scenario {scenario_name} SCENARIO_META.target_compat must not be empty")
    unknown_targets = target_compat - VALID_TARGETS
    if unknown_targets:
        raise ValueError(
            f"scenario {scenario_name} SCENARIO_META.target_compat contains unknown target(s): "
            f"{sorted(unknown_targets)}; expected subset of {sorted(VALID_TARGETS)}"
        )

    requires_raw = raw.get("requires", [])
    if not isinstance(requires_raw, (list, tuple, set, frozenset)):
        raise ValueError(f"scenario {scenario_name} SCENARIO_META.requires must be a list")
    requires = tuple(str(item) for item in requires_raw)
    unknown_requires = frozenset(requires) - VALID_REQUIRES
    if unknown_requires:
        raise ValueError(
            f"scenario {scenario_name} SCENARIO_META.requires contains unknown requirement(s): "
            f"{sorted(unknown_requires)}; expected subset of {sorted(VALID_REQUIRES)}"
        )

    return NormalizedScenarioMeta(target_compat=target_compat, requires=requires)


def skip_reason(meta: NormalizedScenarioMeta) -> str:
    if meta.requires:
        return f"requires {', '.join(meta.requires)}"
    return f"compatible targets: {', '.join(sorted(meta.target_compat))}"
