#!/usr/bin/env python3
"""Render the Voice VAC native asset hero preview with transparent alpha."""

from __future__ import annotations

import argparse
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector


PREVIEW_WIDTH = 1800
PREVIEW_HEIGHT = 1100
HERO_FRAME = 36


def parse_args() -> argparse.Namespace:
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args(arguments)


def point_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def add_area_light(
    name: str,
    location: tuple[float, float, float],
    target: tuple[float, float, float],
    *,
    energy: float,
    size: float,
    color: tuple[float, float, float],
) -> None:
    light_data = bpy.data.lights.new(name, "AREA")
    light_data.energy = energy
    light_data.shape = "DISK"
    light_data.size = size
    light_data.color = color
    light_data.use_shadow = True
    light = bpy.data.objects.new(name, light_data)
    bpy.context.scene.collection.objects.link(light)
    light.location = location
    point_at(light, Vector(target))


def configure_preview(output: Path) -> None:
    for obj in list(bpy.data.objects):
        if obj.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(obj, do_unlink=True)

    scene = bpy.context.scene
    scene.frame_set(HERO_FRAME)
    # The warm ready halo is a dedicated runtime node.  Frame 36 represents
    # attached suction compression, so the hero render exposes the dark
    # mechanical base and brass ring without detaching the runtime nozzle.
    ready_light = bpy.data.objects.get("VAC_BUTTON_READY_LIGHT")
    if ready_light is not None:
        ready_light.hide_render = True
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = PREVIEW_WIDTH
    scene.render.resolution_y = PREVIEW_HEIGHT
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 30
    scene.render.film_transparent = True
    scene.render.filepath = str(output)
    scene.render.resolution_percentage = 100
    scene.render.use_file_extension = True
    scene.render.image_settings.color_mode = "RGBA"

    world = bpy.data.worlds.get("Voice VAC Preview World") or bpy.data.worlds.new("Voice VAC Preview World")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.032, 0.024, 0.017, 1.0)
    background.inputs["Strength"].default_value = 0.38
    scene.world = world

    camera_data = bpy.data.cameras.new("Voice VAC Hero Camera")
    camera_data.lens = 76.0
    camera_data.sensor_width = 36.0
    camera = bpy.data.objects.new("Voice VAC Hero Camera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (0.39, -2.03, 0.43)
    point_at(camera, Vector((-0.155, -0.010, -0.185)))
    scene.camera = camera

    add_area_light(
        "Warm Pearl Key",
        (-0.62, -0.95, 1.10),
        (-0.15, 0.0, -0.16),
        energy=135.0,
        size=1.05,
        color=(1.0, 0.78, 0.56),
    )
    add_area_light(
        "Soft Window Fill",
        (0.72, -0.78, 0.42),
        (-0.10, 0.0, -0.12),
        energy=105.0,
        size=0.88,
        color=(0.80, 0.89, 1.0),
    )
    add_area_light(
        "Red Button Edge",
        (0.34, 0.48, 0.55),
        (0.12, 0.0, 0.0),
        energy=145.0,
        size=0.55,
        color=(1.0, 0.48, 0.30),
    )
    add_area_light(
        "Hose Rim",
        (-0.82, 0.36, -0.08),
        (-0.36, 0.0, -0.28),
        energy=92.0,
        size=0.72,
        color=(0.90, 0.82, 0.65),
    )

    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    scene.view_settings.exposure = -0.32
    bpy.ops.render.render(write_still=True)


def main() -> None:
    args = parse_args()
    if args.asset:
        bpy.ops.wm.open_mainfile(filepath=str(args.asset.resolve()))
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    configure_preview(output)
    print(f"Voice VAC transparent preview: {output} ({PREVIEW_WIDTH}x{PREVIEW_HEIGHT}, frame {HERO_FRAME})")


if __name__ == "__main__":
    main()
