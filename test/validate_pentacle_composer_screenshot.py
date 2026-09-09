#!/usr/bin/env python3
"""Validate that the Pentacle chat composer is visible and not clipped.

This is intentionally screenshot-based because React Native does not expose
the empty composer controls reliably through XCUITest in release builds.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


def near(pixel: tuple[int, int, int], target: tuple[int, int, int], tolerance: int = 38) -> bool:
    return all(abs(int(value) - expected) <= tolerance for value, expected in zip(pixel, target))


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate_pentacle_composer_screenshot.py <screenshot.png>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    image = Image.open(path).convert("RGB")
    width, height = image.size

    bottom_start = int(height * 0.78)
    bottom = image.crop((0, bottom_start, width, height))
    pixels = bottom.load()
    bottom_width, bottom_height = bottom.size

    border_green = (53, 97, 80)
    button_green = (36, 92, 73)
    dark_panel = (14, 24, 20)

    green_pixels = 0
    dark_pixels = 0
    min_green_y = bottom_height
    max_green_y = 0

    for y in range(bottom_height):
        for x in range(bottom_width):
            pixel = pixels[x, y]
            if near(pixel, border_green) or near(pixel, button_green):
                green_pixels += 1
                min_green_y = min(min_green_y, y)
                max_green_y = max(max_green_y, y)
            if near(pixel, dark_panel, tolerance=30):
                dark_pixels += 1

    min_required_green = int(width * 2)
    min_required_dark = int(width * 24)
    if green_pixels < min_required_green:
        raise AssertionError(f"composer border/button not visible enough: {green_pixels} green pixels")
    if dark_pixels < min_required_dark:
        raise AssertionError(f"composer input panel not visible enough: {dark_pixels} dark pixels")

    composer_bottom_margin = bottom_height - max_green_y
    if composer_bottom_margin < 16:
        raise AssertionError(f"composer is too close to the curved screen edge: {composer_bottom_margin}px margin")
    if composer_bottom_margin > 96:
        raise AssertionError(f"composer has too much bottom gap: {composer_bottom_margin}px margin")
    if min_green_y > bottom_height * 0.72:
        raise AssertionError("composer appears too low or mostly offscreen")

    print(
        f"composer visible: green_pixels={green_pixels}, dark_pixels={dark_pixels}, "
        f"bottom_margin={composer_bottom_margin}px"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
