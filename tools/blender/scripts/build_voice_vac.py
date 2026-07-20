#!/usr/bin/env python3
"""Build the production Voice VAC game-prop asset set reproducibly by semantics.

This script is the reproducible source of truth for the Blender authoring file,
the two RealityKit USDZ packages, the diagnostic GLB, and asset-contract.json.
All visible production silhouettes are authored profile meshes; Blender
primitives are deliberately not used for the nozzle, hose, port, or button.
Blender and USD container bytes may carry tool metadata, so reproducibility is
asserted through a normalized scene-semantic fingerprint, never byte identity.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import sys
from pathlib import Path
from typing import Iterable, Sequence

import bpy
from mathutils import Matrix, Vector


SCHEMA_VERSION = 2
JOINT_NAMES = [f"VAC_HOSE_JOINT_{index:02d}" for index in range(64)]
MATERIAL_NAMES = [
    "MAT_PEARL_PLASTIC",
    "MAT_PEARL_RIBBED",
    "MAT_CHARCOAL_RUBBER",
    "MAT_CHARCOAL_METAL",
    "MAT_BUTTON_RED",
    "MAT_BRASS_ACCENT",
    "MAT_MOUTH_DARK",
]
RUNTIME_NODES = [
    "VAC_DEVICE_ROOT",
    "VAC_PORT",
    "VAC_NOZZLE",
    "VAC_NOZZLE_TIP",
    "VAC_BUTTON_BASE",
    "VAC_BUTTON_CAP",
    "VAC_HOSE_ROOT",
    "VAC_HOSE_SKIN",
]
BUTTON_TRAVEL_METERS = 0.009
DOCK_LOCATION = Vector((-0.132, -0.037, 0.002))
HOSE_RIB_COUNT = 52
HOSE_SAMPLES_PER_RIB = 6
HOSE_SIDES = 28
CORRECTIVE_SHAPE_NAMES = ("bendPositive", "bendNegative")
MESH_BINARY_MAGIC = b"VACHOSE\0"
MESH_BINARY_VERSION = 1
MESH_BINARY_HEADER_BYTES = 160
MESH_BINARY_ENDIAN_MARKER = 0x01020304
NAMED_POSE_SPECS = {
    "nozzleDocked": ("VAC_NOZZLE", "VAC_NOZZLE_POSES", 1),
    "nozzleLiftRotate": ("VAC_NOZZLE", "VAC_NOZZLE_POSES", 10),
    "nozzleDeployed": ("VAC_NOZZLE", "VAC_NOZZLE_POSES", 24),
    "nozzleAttachmentCompression": ("VAC_NOZZLE", "VAC_NOZZLE_POSES", 36),
    "buttonUp": ("VAC_BUTTON_CAP", "VAC_BUTTON_POSES", 1),
    "buttonReady": ("VAC_BUTTON_CAP", "VAC_BUTTON_POSES", 10),
    "buttonDown": ("VAC_BUTTON_CAP", "VAC_BUTTON_POSES", 20),
    "buttonPaused": ("VAC_BUTTON_CAP", "VAC_BUTTON_POSES", 30),
}


def parse_args() -> argparse.Namespace:
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(arguments)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for collection in list(bpy.data.collections):
        if collection.users == 0:
            bpy.data.collections.remove(collection)


def configure_scene() -> None:
    scene = bpy.context.scene
    scene.name = "Voice VAC Production Asset"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0
    scene["voice_vac_contract_version"] = SCHEMA_VERSION
    scene["voice_vac_forward_axis"] = "-Z"
    scene["voice_vac_up_axis"] = "Y"
    scene["voice_vac_authoring_up_axis"] = "Z"
    scene["voice_vac_runtime_pose_delivery"] = "namedTransforms"
    scene["voice_vac_usdz_animation_time_samples"] = False
    scene.frame_start = 1
    scene.frame_end = 48
    scene.render.fps = 24
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass


def create_collection(name: str) -> bpy.types.Collection:
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection


def create_material(
    name: str,
    base_color: tuple[float, float, float, float],
    *,
    metallic: float,
    roughness: float,
    coat_weight: float = 0.0,
    coat_roughness: float = 0.2,
    subsurface_weight: float = 0.0,
    handmade_bump: float = 0.0,
) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = base_color
    material["voice_vac_pbr"] = True
    material["voice_vac_role"] = name.removeprefix("MAT_").lower()
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = base_color
    principled.inputs["Metallic"].default_value = metallic
    principled.inputs["Roughness"].default_value = roughness
    if "Coat Weight" in principled.inputs:
        principled.inputs["Coat Weight"].default_value = coat_weight
    if "Coat Roughness" in principled.inputs:
        principled.inputs["Coat Roughness"].default_value = coat_roughness
    if "Subsurface Weight" in principled.inputs:
        principled.inputs["Subsurface Weight"].default_value = subsurface_weight
    if handmade_bump > 0.0:
        noise = nodes.new("ShaderNodeTexNoise")
        noise.name = f"{name}_HANDMADE_GRAIN"
        noise.inputs["Scale"].default_value = 135.0
        noise.inputs["Detail"].default_value = 2.2
        noise.inputs["Roughness"].default_value = 0.55
        bump = nodes.new("ShaderNodeBump")
        bump.name = f"{name}_MICRO_BUMP"
        bump.inputs["Strength"].default_value = handmade_bump
        bump.inputs["Distance"].default_value = 0.00035
        links.new(noise.outputs["Fac"], bump.inputs["Height"])
        links.new(bump.outputs["Normal"], principled.inputs["Normal"])
    return material


def build_materials() -> dict[str, bpy.types.Material]:
    return {
        "MAT_PEARL_PLASTIC": create_material(
            "MAT_PEARL_PLASTIC",
            (0.91, 0.875, 0.79, 1.0),
            metallic=0.02,
            roughness=0.24,
            coat_weight=0.34,
            coat_roughness=0.16,
            subsurface_weight=0.025,
            handmade_bump=0.055,
        ),
        "MAT_PEARL_RIBBED": create_material(
            "MAT_PEARL_RIBBED",
            # The bellows must read as warm white plastic at desktop scale.
            # A darker beige looks elegant in Blender but turns into black
            # stripes when only the ridge valleys are visible in Metal.
            (0.93, 0.91, 0.84, 1.0),
            metallic=0.0,
            roughness=0.38,
            coat_weight=0.16,
            coat_roughness=0.26,
            subsurface_weight=0.018,
            handmade_bump=0.075,
        ),
        "MAT_CHARCOAL_RUBBER": create_material(
            "MAT_CHARCOAL_RUBBER",
            (0.045, 0.041, 0.037, 1.0),
            metallic=0.0,
            roughness=0.48,
            coat_weight=0.08,
            handmade_bump=0.04,
        ),
        "MAT_CHARCOAL_METAL": create_material(
            "MAT_CHARCOAL_METAL",
            (0.072, 0.067, 0.06, 1.0),
            metallic=0.74,
            roughness=0.22,
            coat_weight=0.25,
            coat_roughness=0.13,
        ),
        "MAT_BUTTON_RED": create_material(
            "MAT_BUTTON_RED",
            (0.255, 0.004, 0.003, 1.0),
            metallic=0.04,
            roughness=0.24,
            coat_weight=0.36,
            coat_roughness=0.16,
            subsurface_weight=0.025,
            handmade_bump=0.028,
        ),
        "MAT_BRASS_ACCENT": create_material(
            "MAT_BRASS_ACCENT",
            (0.54, 0.305, 0.082, 1.0),
            metallic=0.82,
            roughness=0.21,
            coat_weight=0.22,
        ),
        "MAT_MOUTH_DARK": create_material(
            "MAT_MOUTH_DARK",
            (0.0025, 0.0018, 0.0014, 1.0),
            metallic=0.0,
            roughness=0.78,
        ),
    }


def add_empty(name: str, collection: bpy.types.Collection) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "CIRCLE"
    obj.empty_display_size = 0.025
    collection.objects.link(obj)
    return obj


def create_mesh_object(
    name: str,
    vertices: Sequence[Sequence[float]],
    faces: Sequence[Sequence[int]],
    vertex_uvs: Sequence[Sequence[float]],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    *,
    smooth: bool = True,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(f"{name}_MESH")
    mesh.from_pydata(vertices, [], faces)
    mesh.update(calc_edges=True)
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for loop in mesh.loops:
        uv_layer.data[loop.index].uv = vertex_uvs[loop.vertex_index]
    for polygon in mesh.polygons:
        polygon.use_smooth = smooth
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.data.materials.append(material)
    obj["voice_vac_authored_profile"] = True
    return obj


def add_bevel(obj: bpy.types.Object, width: float, segments: int = 3) -> None:
    modifier = obj.modifiers.new("Authored edge softness", "BEVEL")
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)


def lathe_mesh(
    name: str,
    profile: Sequence[tuple[float, float]],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    *,
    segments: int = 72,
    radial_ripple: float = 0.0,
    ripple_count: int = 18,
    cap_start: bool = True,
    cap_end: bool = True,
) -> bpy.types.Object:
    vertices: list[tuple[float, float, float]] = []
    uvs: list[tuple[float, float]] = []
    faces: list[tuple[int, ...]] = []
    ring_count = len(profile)
    for ring_index, (axis_y, radius) in enumerate(profile):
        profile_weight = math.sin(math.pi * ring_index / max(1, ring_count - 1)) ** 2
        for segment in range(segments):
            theta = 2.0 * math.pi * segment / segments
            ripple = 1.0 + radial_ripple * profile_weight * math.cos(ripple_count * theta)
            ring_radius = radius * ripple
            vertices.append((ring_radius * math.cos(theta), axis_y, ring_radius * math.sin(theta)))
            uvs.append((segment / segments, ring_index / max(1, ring_count - 1)))
    for ring_index in range(ring_count - 1):
        for segment in range(segments):
            next_segment = (segment + 1) % segments
            lower = ring_index * segments + segment
            lower_next = ring_index * segments + next_segment
            upper_next = (ring_index + 1) * segments + next_segment
            upper = (ring_index + 1) * segments + segment
            faces.append((lower, lower_next, upper_next, upper))
    if cap_start:
        center = len(vertices)
        vertices.append((0.0, profile[0][0], 0.0))
        uvs.append((0.5, 0.5))
        for segment in range(segments):
            faces.append((center, (segment + 1) % segments, segment))
    if cap_end:
        center = len(vertices)
        vertices.append((0.0, profile[-1][0], 0.0))
        uvs.append((0.5, 0.5))
        start = (ring_count - 1) * segments
        for segment in range(segments):
            faces.append((center, start + segment, start + (segment + 1) % segments))
    return create_mesh_object(name, vertices, faces, uvs, material, collection)


def superellipse_point(theta: float, half_width: float, half_height: float, exponent: float) -> tuple[float, float]:
    cosine = math.cos(theta)
    sine = math.sin(theta)
    power = 2.0 / exponent
    x = half_width * math.copysign(abs(cosine) ** power, cosine)
    z = half_height * math.copysign(abs(sine) ** power, sine)
    return x, z


def superellipse_loft(
    name: str,
    sections: Sequence[tuple[float, float, float, float, float]],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    *,
    segments: int = 48,
    cap_start: bool = True,
    cap_end: bool = False,
) -> bpy.types.Object:
    vertices: list[tuple[float, float, float]] = []
    uvs: list[tuple[float, float]] = []
    faces: list[tuple[int, ...]] = []
    for section_index, (axis_y, half_width, half_height, exponent, z_offset) in enumerate(sections):
        for segment in range(segments):
            theta = 2.0 * math.pi * segment / segments
            x, z = superellipse_point(theta, half_width, half_height, exponent)
            handmade = 1.0 + 0.004 * math.sin(segment * 1.71 + section_index * 0.83)
            vertices.append((x * handmade, axis_y, z * handmade + z_offset))
            uvs.append((segment / segments, section_index / max(1, len(sections) - 1)))
    for section_index in range(len(sections) - 1):
        for segment in range(segments):
            next_segment = (segment + 1) % segments
            a = section_index * segments + segment
            b = section_index * segments + next_segment
            c = (section_index + 1) * segments + next_segment
            d = (section_index + 1) * segments + segment
            faces.append((a, b, c, d))
    if cap_start:
        center = len(vertices)
        axis_y, _, _, _, z_offset = sections[0]
        vertices.append((0.0, axis_y, z_offset))
        uvs.append((0.5, 0.5))
        for segment in range(segments):
            faces.append((center, (segment + 1) % segments, segment))
    if cap_end:
        center = len(vertices)
        axis_y, _, _, _, z_offset = sections[-1]
        vertices.append((0.0, axis_y, z_offset))
        uvs.append((0.5, 0.5))
        start = (len(sections) - 1) * segments
        for segment in range(segments):
            faces.append((center, start + segment, start + (segment + 1) % segments))
    return create_mesh_object(name, vertices, faces, uvs, material, collection)


def superellipse_ring(
    name: str,
    *,
    front_y: float,
    back_y: float,
    outer: tuple[float, float, float],
    inner: tuple[float, float, float],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    segments: int = 56,
) -> bpy.types.Object:
    vertices: list[tuple[float, float, float]] = []
    uvs: list[tuple[float, float]] = []
    faces: list[tuple[int, ...]] = []
    rings = (
        (front_y, *outer),
        (front_y - 0.0006, *inner),
        (back_y, *outer),
        (back_y + 0.0006, *inner),
    )
    for ring_index, (axis_y, half_width, half_height, exponent) in enumerate(rings):
        for segment in range(segments):
            theta = 2.0 * math.pi * segment / segments
            x, z = superellipse_point(theta, half_width, half_height, exponent)
            vertices.append((x, axis_y, z))
            uvs.append((segment / segments, ring_index / 3.0))
    for segment in range(segments):
        nxt = (segment + 1) % segments
        outer_front = segment
        inner_front = segments + segment
        outer_back = 2 * segments + segment
        inner_back = 3 * segments + segment
        faces.extend(
            [
                (outer_front, nxt, segments + nxt, inner_front),
                (outer_front, outer_back, 2 * segments + nxt, nxt),
                (inner_front, segments + nxt, 3 * segments + nxt, inner_back),
                (outer_back, inner_back, 3 * segments + nxt, 2 * segments + nxt),
            ]
        )
    return create_mesh_object(name, vertices, faces, uvs, material, collection)


def superellipse_disc(
    name: str,
    *,
    axis_y: float,
    half_width: float,
    half_height: float,
    exponent: float,
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    segments: int = 56,
) -> bpy.types.Object:
    vertices: list[tuple[float, float, float]] = [(0.0, axis_y, 0.0)]
    uvs: list[tuple[float, float]] = [(0.5, 0.5)]
    faces: list[tuple[int, int, int]] = []
    for segment in range(segments):
        theta = 2.0 * math.pi * segment / segments
        x, z = superellipse_point(theta, half_width, half_height, exponent)
        vertices.append((x, axis_y, z))
        uvs.append((0.5 + x / (2.0 * half_width), 0.5 + z / (2.0 * half_height)))
    for segment in range(segments):
        faces.append((0, segment + 1, ((segment + 1) % segments) + 1))
    return create_mesh_object(name, vertices, faces, uvs, material, collection)


def parent(child: bpy.types.Object, parent_object: bpy.types.Object) -> bpy.types.Object:
    child.parent = parent_object
    return child


def build_device(
    collection: bpy.types.Collection,
    materials: dict[str, bpy.types.Material],
) -> dict[str, bpy.types.Object]:
    device_root = add_empty("VAC_DEVICE_ROOT", collection)
    device_root.empty_display_type = "PLAIN_AXES"
    device_root["voice_vac_runtime_root"] = "device"

    port_profile = [
        (0.029, 0.037),
        (0.024, 0.046),
        (0.017, 0.053),
        (0.009, 0.058),
        (-0.001, 0.060),
        (-0.011, 0.058),
        (-0.021, 0.052),
        (-0.029, 0.045),
    ]
    port = lathe_mesh(
        "VAC_PORT",
        port_profile,
        materials["MAT_PEARL_PLASTIC"],
        collection,
        radial_ripple=0.003,
        ripple_count=24,
        cap_start=False,
        cap_end=False,
    )
    port.location = (-0.132, 0.006, 0.002)
    parent(port, device_root)

    socket = lathe_mesh(
        "VAC_PORT_SOCKET",
        [
            (-0.006, 0.046),
            (-0.002, 0.045),
            (0.004, 0.041),
            (0.010, 0.034),
            (0.016, 0.024),
            (0.021, 0.013),
            (0.024, 0.004),
        ],
        materials["MAT_MOUTH_DARK"],
        collection,
        segments=64,
        cap_start=False,
        cap_end=True,
    )
    socket.location = (-0.132, -0.018, 0.002)
    parent(socket, device_root)

    port_accent = lathe_mesh(
        "VAC_PORT_ACCENT",
        [(-0.020, 0.045), (-0.024, 0.049), (-0.028, 0.049), (-0.031, 0.045)],
        materials["MAT_BRASS_ACCENT"],
        collection,
        segments=72,
        cap_start=False,
        cap_end=False,
    )
    port_accent.location = (-0.132, 0.006, 0.002)
    parent(port_accent, device_root)

    nozzle = add_empty("VAC_NOZZLE", collection)
    nozzle.empty_display_type = "ARROWS"
    nozzle.location = DOCK_LOCATION
    nozzle.rotation_mode = "XYZ"
    nozzle.rotation_euler = (0.0, math.radians(90.0), 0.0)
    nozzle["voice_vac_pivot"] = "rotary_collar_center"
    parent(nozzle, device_root)

    nozzle_shell = superellipse_loft(
        "VAC_NOZZLE_SHELL",
        [
            (0.002, 0.028, 0.027, 2.2, 0.0),
            (-0.018, 0.034, 0.029, 2.5, 0.001),
            (-0.038, 0.046, 0.030, 3.0, 0.0015),
            (-0.058, 0.061, 0.028, 3.8, 0.001),
            (-0.078, 0.074, 0.025, 4.6, 0.0005),
            (-0.093, 0.083, 0.0225, 5.0, 0.0),
        ],
        materials["MAT_PEARL_PLASTIC"],
        collection,
        segments=56,
        cap_start=True,
        cap_end=False,
    )
    parent(nozzle_shell, nozzle)
    add_bevel(nozzle_shell, 0.0011, 3)

    throat_collar = lathe_mesh(
        "VAC_NOZZLE_COLLAR",
        [(0.010, 0.029), (0.004, 0.034), (-0.003, 0.035), (-0.010, 0.031)],
        materials["MAT_CHARCOAL_METAL"],
        collection,
        segments=64,
        radial_ripple=0.032,
        ripple_count=16,
        cap_start=False,
        cap_end=False,
    )
    parent(throat_collar, nozzle)

    nozzle_tip = superellipse_ring(
        "VAC_NOZZLE_TIP",
        front_y=-0.101,
        back_y=-0.090,
        outer=(0.087, 0.0265, 5.2),
        inner=(0.0755, 0.0165, 4.8),
        material=materials["MAT_PEARL_PLASTIC"],
        collection=collection,
    )
    parent(nozzle_tip, nozzle)
    add_bevel(nozzle_tip, 0.0008, 3)

    gasket = superellipse_ring(
        "VAC_NOZZLE_GASKET",
        front_y=-0.103,
        back_y=-0.098,
        outer=(0.077, 0.018, 4.8),
        inner=(0.070, 0.0125, 4.4),
        material=materials["MAT_CHARCOAL_RUBBER"],
        collection=collection,
        segments=56,
    )
    parent(gasket, nozzle)

    mouth = superellipse_disc(
        "VAC_NOZZLE_MOUTH",
        axis_y=-0.099,
        half_width=0.069,
        half_height=0.0118,
        exponent=4.5,
        material=materials["MAT_MOUTH_DARK"],
        collection=collection,
    )
    parent(mouth, nozzle)

    # Two authored cheek pads catch a small warm highlight at capsule scale.
    for side in (-1.0, 1.0):
        cheek = superellipse_loft(
            f"VAC_NOZZLE_CHEEK_{'L' if side < 0 else 'R'}",
            [
                (-0.043, 0.009, 0.009, 3.6, side * 0.0),
                (-0.067, 0.014, 0.007, 4.0, side * 0.0),
            ],
            materials["MAT_BRASS_ACCENT"],
            collection,
            segments=24,
            cap_start=True,
            cap_end=True,
        )
        cheek.scale.x = 0.65
        cheek.location.x = side * 0.052
        cheek.location.z = -0.018
        parent(cheek, nozzle)

    button_base = lathe_mesh(
        "VAC_BUTTON_BASE",
        [
            (0.025, 0.041),
            (0.019, 0.051),
            (0.009, 0.058),
            (-0.004, 0.061),
            (-0.018, 0.057),
            (-0.027, 0.048),
        ],
        materials["MAT_CHARCOAL_METAL"],
        collection,
        segments=80,
        radial_ripple=0.006,
        ripple_count=12,
    )
    button_base.location = (0.128, 0.006, 0.002)
    parent(button_base, device_root)
    add_bevel(button_base, 0.0011, 3)

    button_ring = lathe_mesh(
        "VAC_BUTTON_ACCENT_RING",
        [(-0.020, 0.043), (-0.025, 0.050), (-0.030, 0.050), (-0.034, 0.043)],
        materials["MAT_BRASS_ACCENT"],
        collection,
        segments=80,
        cap_start=False,
        cap_end=False,
    )
    button_ring.location = (0.128, 0.006, 0.002)
    parent(button_ring, device_root)

    button_cap = lathe_mesh(
        "VAC_BUTTON_CAP",
        [
            (-0.024, 0.035),
            (-0.030, 0.043),
            (-0.039, 0.047),
            (-0.048, 0.045),
            (-0.055, 0.037),
            (-0.061, 0.023),
            (-0.065, 0.008),
        ],
        materials["MAT_BUTTON_RED"],
        collection,
        segments=88,
        radial_ripple=0.006,
        ripple_count=18,
        cap_start=True,
        cap_end=True,
    )
    button_cap.location = (0.128, 0.006, 0.002)
    button_cap["voice_vac_travel_meters"] = BUTTON_TRAVEL_METERS
    parent(button_cap, device_root)
    add_bevel(button_cap, 0.0009, 3)

    ready_light = lathe_mesh(
        "VAC_BUTTON_READY_LIGHT",
        [(-0.021, 0.051), (-0.024, 0.054), (-0.028, 0.054), (-0.031, 0.051)],
        materials["MAT_PEARL_PLASTIC"],
        collection,
        segments=80,
        cap_start=False,
        cap_end=False,
    )
    ready_light.location = (0.128, 0.006, 0.002)
    ready_light["voice_vac_ready_glow_mesh"] = True
    parent(ready_light, device_root)

    return {
        "device_root": device_root,
        "port": port,
        "nozzle": nozzle,
        "nozzle_tip": nozzle_tip,
        "button_base": button_base,
        "button_cap": button_cap,
    }


def hose_centerline() -> list[Vector]:
    points: list[Vector] = []
    for index in range(65):
        t = index / 64.0
        ease = t * t * (3.0 - 2.0 * t)
        x = -0.132 - 0.305 * ease - 0.047 * math.sin(math.pi * t) + 0.009 * math.sin(5.0 * math.pi * t)
        y = 0.028 + 0.014 * math.sin(2.0 * math.pi * t + 0.35) + 0.004 * math.sin(7.0 * math.pi * t)
        z = 0.002 - 0.365 * t - 0.050 * math.sin(math.pi * t) + 0.008 * math.sin(4.0 * math.pi * t + 0.6)
        points.append(Vector((x, y, z)))
    return points


def sample_polyline(points: Sequence[Vector], t: float) -> tuple[Vector, Vector]:
    position = max(0.0, min(1.0, t)) * (len(points) - 1)
    index = min(int(position), len(points) - 2)
    fraction = position - index
    center = points[index].lerp(points[index + 1], fraction)
    previous = points[max(0, index - 1)]
    following = points[min(len(points) - 1, index + 2)]
    tangent = (following - previous).normalized()
    return center, tangent


def build_hose(
    collection: bpy.types.Collection,
    materials: dict[str, bpy.types.Material],
) -> dict[str, bpy.types.Object]:
    points = hose_centerline()
    armature_data = bpy.data.armatures.new("VAC_HOSE_RIG")
    armature = bpy.data.objects.new("VAC_HOSE_ROOT", armature_data)
    collection.objects.link(armature)
    armature.show_in_front = True
    armature.display_type = "WIRE"
    armature["voice_vac_runtime_root"] = "hose"
    armature["voice_vac_joint_count"] = 64

    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    previous_bone = None
    for index, name in enumerate(JOINT_NAMES):
        bone = armature_data.edit_bones.new(name)
        bone.head = points[index]
        bone.tail = points[index + 1]
        bone.parent = previous_bone
        bone.use_connect = previous_bone is not None
        previous_bone = bone
    bpy.ops.object.mode_set(mode="OBJECT")
    armature.select_set(False)

    ring_count = HOSE_RIB_COUNT * HOSE_SAMPLES_PER_RIB + 1
    vertices: list[tuple[float, float, float]] = []
    uvs: list[tuple[float, float]] = []
    faces: list[tuple[int, ...]] = []
    ring_vertex_indices: list[list[int]] = []
    ring_centers: list[Vector] = []
    reference = Vector((0.0, 1.0, 0.0))
    previous_normal: Vector | None = None
    for ring_index in range(ring_count):
        t = ring_index / (ring_count - 1)
        center, tangent = sample_polyline(points, t)
        normal = tangent.cross(reference)
        if normal.length < 1.0e-6:
            normal = tangent.cross(Vector((1.0, 0.0, 0.0)))
        normal.normalize()
        if previous_normal is not None and normal.dot(previous_normal) < 0.0:
            normal.negate()
        binormal = tangent.cross(normal).normalized()
        previous_normal = normal.copy()
        ring_centers.append(center.copy())

        phase = t * HOSE_RIB_COUNT
        # Six longitudinal samples and a soft cosine shoulder keep each fold
        # inflated.  Four-sample/high-power peaks read as a saw blade at the
        # final capsule scale, while this profile reads as accordion duct.
        ridge = (0.5 + 0.5 * math.cos(2.0 * math.pi * phase)) ** 1.55
        compression_zone = 0.965 + 0.025 * math.sin(2.0 * math.pi * t + 0.4) + 0.012 * math.sin(9.0 * math.pi * t)
        radius = (0.0202 + 0.0058 * ridge) * compression_zone
        ring_indices: list[int] = []
        for side in range(HOSE_SIDES):
            theta = 2.0 * math.pi * side / HOSE_SIDES
            handmade = 1.0 + 0.010 * math.sin(3.0 * theta + ring_index * 0.19) + 0.004 * math.sin(7.0 * theta - ring_index * 0.11)
            offset = normal * (math.cos(theta) * radius * handmade) + binormal * (math.sin(theta) * radius * handmade)
            ring_indices.append(len(vertices))
            vertices.append(tuple(center + offset))
            uvs.append((side / HOSE_SIDES, t * HOSE_RIB_COUNT / 8.0))
        ring_vertex_indices.append(ring_indices)

    for ring_index in range(ring_count - 1):
        for side in range(HOSE_SIDES):
            nxt = (side + 1) % HOSE_SIDES
            faces.append(
                (
                    ring_vertex_indices[ring_index][side],
                    ring_vertex_indices[ring_index][nxt],
                    ring_vertex_indices[ring_index + 1][nxt],
                    ring_vertex_indices[ring_index + 1][side],
                )
            )
    start_center = len(vertices)
    vertices.append(tuple(points[0]))
    uvs.append((0.5, 0.0))
    end_center = len(vertices)
    vertices.append(tuple(points[-1]))
    uvs.append((0.5, 1.0))
    for side in range(HOSE_SIDES):
        nxt = (side + 1) % HOSE_SIDES
        faces.append((start_center, ring_vertex_indices[0][nxt], ring_vertex_indices[0][side]))
        faces.append((end_center, ring_vertex_indices[-1][side], ring_vertex_indices[-1][nxt]))

    skin = create_mesh_object(
        "VAC_HOSE_SKIN",
        vertices,
        faces,
        uvs,
        materials["MAT_PEARL_RIBBED"],
        collection,
    )
    skin.parent = armature
    skin["voice_vac_continuous_corrugation"] = True
    skin["voice_vac_rib_count"] = HOSE_RIB_COUNT
    for name in JOINT_NAMES:
        skin.vertex_groups.new(name=name)
    for ring_index, indices in enumerate(ring_vertex_indices):
        t = ring_index / (ring_count - 1)
        joint_position = t * (len(JOINT_NAMES) - 1)
        lower = min(int(joint_position), len(JOINT_NAMES) - 1)
        upper = min(lower + 1, len(JOINT_NAMES) - 1)
        upper_weight = joint_position - lower
        lower_weight = 1.0 - upper_weight
        skin.vertex_groups[JOINT_NAMES[lower]].add(indices, lower_weight, "REPLACE")
        if upper != lower and upper_weight > 0.0:
            skin.vertex_groups[JOINT_NAMES[upper]].add(indices, upper_weight, "ADD")
    skin.vertex_groups[JOINT_NAMES[0]].add([start_center], 1.0, "REPLACE")
    skin.vertex_groups[JOINT_NAMES[-1]].add([end_center], 1.0, "REPLACE")
    modifier = skin.modifiers.new("Voice VAC 64-joint deformation", "ARMATURE")
    modifier.object = armature
    modifier.use_deform_preserve_volume = True

    basis = skin.shape_key_add(name="Basis")
    for shape_name, side_sign in zip(CORRECTIVE_SHAPE_NAMES, (-1.0, 1.0)):
        shape = skin.shape_key_add(name=shape_name)
        shape.value = 0.0
        shape.slider_min = 0.0
        shape.slider_max = 1.0
        for ring_index, indices in enumerate(ring_vertex_indices):
            t = ring_index / (ring_count - 1)
            if not 0.18 <= t <= 0.82:
                continue
            longitudinal = math.sin(math.pi * ((t - 0.18) / 0.64)) ** 2
            for side, vertex_index in enumerate(indices):
                side_coordinate = math.cos(2.0 * math.pi * side / HOSE_SIDES)
                signed_inner = side_sign * side_coordinate
                if signed_inner <= 0.35:
                    continue
                side_envelope = ((signed_inner - 0.35) / 0.65) ** 2
                radial = basis.data[vertex_index].co - ring_centers[ring_index]
                if radial.length <= 1.0e-8:
                    continue
                delta = -radial.normalized() * (0.00145 * longitudinal * side_envelope)
                shape.data[vertex_index].co = basis.data[vertex_index].co + delta
    skin["voice_vac_corrective_shapes"] = json.dumps(CORRECTIVE_SHAPE_NAMES)
    skin["voice_vac_corrective_space"] = "rest-object-space"

    return {"hose_root": armature, "hose_skin": skin, "points": points}


def create_object_action(
    obj: bpy.types.Object,
    name: str,
    poses: Sequence[tuple[int, Vector, tuple[float, float, float], Vector]],
) -> bpy.types.Action:
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    animation_data = obj.animation_data_create()
    animation_data.action = action
    obj.rotation_mode = "XYZ"
    for frame, location, rotation, scale in poses:
        obj.location = location
        obj.rotation_euler = rotation
        obj.scale = scale
        obj.keyframe_insert(data_path="location", frame=frame)
        obj.keyframe_insert(data_path="rotation_euler", frame=frame)
        obj.keyframe_insert(data_path="scale", frame=frame)
    # Keep the action actively bound.  Clearing it here leaves the object at
    # the last manually authored pose, so frame_set(1) cannot restore rest.
    bpy.context.scene.frame_set(1)
    return action


def build_actions(device: dict[str, bpy.types.Object], hose: dict[str, bpy.types.Object]) -> None:
    nozzle = device["nozzle"]
    tip_point: Vector = hose["points"][-1]
    create_object_action(
        nozzle,
        "VAC_NOZZLE_POSES",
        [
            (1, DOCK_LOCATION, (0.0, math.radians(90.0), 0.0), Vector((1.0, 1.0, 1.0))),
            (10, DOCK_LOCATION + Vector((0.0, -0.010, 0.018)), (0.0, math.radians(22.0), 0.0), Vector((1.0, 1.0, 1.0))),
            (24, tip_point + Vector((0.0, -0.018, 0.0)), (0.0, 0.0, math.radians(-8.0)), Vector((1.0, 1.0, 1.0))),
            (36, tip_point + Vector((0.0, -0.012, 0.0)), (math.radians(4.0), 0.0, math.radians(-8.0)), Vector((1.0, 0.92, 1.04))),
        ],
    )

    button_cap = device["button_cap"]
    button_up = Vector((0.128, 0.006, 0.002))
    create_object_action(
        button_cap,
        "VAC_BUTTON_POSES",
        [
            (1, button_up, (0.0, 0.0, 0.0), Vector((1.0, 1.0, 1.0))),
            (10, button_up + Vector((0.0, -0.0005, 0.0)), (0.0, 0.0, 0.0), Vector((1.006, 0.995, 1.006))),
            (20, button_up + Vector((0.0, BUTTON_TRAVEL_METERS, 0.0)), (0.0, 0.0, 0.0), Vector((1.03, 0.94, 1.03))),
            (30, button_up + Vector((0.0, BUTTON_TRAVEL_METERS * 0.48, 0.0)), (0.0, 0.0, 0.0), Vector((1.015, 0.98, 1.015))),
        ],
    )

    armature: bpy.types.Object = hose["hose_root"]
    action = bpy.data.actions.new("VAC_HOSE_POSES")
    action.use_fake_user = True
    animation_data = armature.animation_data_create()
    animation_data.action = action
    for pose_bone in armature.pose.bones:
        pose_bone.rotation_mode = "QUATERNION"
        pose_bone.scale = (1.0, 1.0, 1.0)
        pose_bone.keyframe_insert(data_path="scale", frame=1)
        index = int(pose_bone.name.rsplit("_", 1)[-1])
        compression = 0.94 + 0.04 * math.sin(index * 0.72)
        pose_bone.scale = (1.025, compression, 1.025)
        pose_bone.keyframe_insert(data_path="scale", frame=24)
        pose_bone.scale = (1.0, 1.0, 1.0)
        pose_bone.keyframe_insert(data_path="scale", frame=36)

    bpy.context.scene["voice_vac_pose_frames"] = json.dumps(
        {
            "nozzleVerticalDock": 1,
            "nozzleLiftRotate": 10,
            "nozzleHorizontalDeploy": 24,
            "attachmentCompression": 36,
            "buttonUp": 1,
            "buttonReady": 10,
            "buttonDown": 20,
            "buttonPaused": 30,
            "hoseRest": 1,
            "hoseSuctionPulse": 24,
        },
        sort_keys=True,
    )
    bpy.context.scene.frame_set(1)


def select_tree(root: bpy.types.Object) -> None:
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)


def export_usdz(path: Path, roots: Sequence[bpy.types.Object], root_prim_path: str) -> None:
    # Runtime movement is driven by named transforms from asset-contract.json.
    # Export only the evaluated frame-1 rest pose so RealityKit never receives
    # an ambiguous implicit clip or a last-authored transform.
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    for root in roots:
        select_tree(root)
    bpy.context.view_layer.objects.active = roots[0]
    bpy.ops.wm.usd_export(
        filepath=str(path),
        selected_objects_only=True,
        export_animation=False,
        export_uvmaps=True,
        export_normals=True,
        export_materials=True,
        export_armatures=True,
        only_deform_bones=False,
        export_shapekeys=True,
        use_instancing=False,
        evaluation_mode="RENDER",
        generate_preview_surface=True,
        convert_orientation=True,
        export_global_forward_selection="NEGATIVE_Z",
        export_global_up_selection="Y",
        convert_scene_units="METERS",
        meters_per_unit=1.0,
        root_prim_path=root_prim_path,
        export_custom_properties=True,
        relative_paths=True,
        author_blender_name=True,
        merge_parent_xform=False,
    )
    bpy.ops.object.select_all(action="DESELECT")


def export_diagnostic_glb(path: Path, roots: Sequence[bpy.types.Object]) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for root in roots:
        select_tree(root)
    bpy.context.view_layer.objects.active = roots[0]
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_animations=True,
        export_skins=True,
        export_morph=True,
        export_materials="EXPORT",
        export_yup=True,
    )
    bpy.ops.object.select_all(action="DESELECT")


def local_bounds(obj: bpy.types.Object) -> dict[str, list[float]]:
    inverse = obj.matrix_world.inverted_safe()
    coordinates: list[Vector] = []
    candidates = [obj, *obj.children_recursive]
    for candidate in candidates:
        if candidate.type != "MESH":
            continue
        relative = inverse @ candidate.matrix_world
        coordinates.extend(relative @ Vector(corner) for corner in candidate.bound_box)
    if not coordinates and obj.type == "ARMATURE":
        coordinates.extend(inverse @ obj.matrix_world @ bone.head_local for bone in obj.data.bones)
        coordinates.extend(inverse @ obj.matrix_world @ bone.tail_local for bone in obj.data.bones)
    if not coordinates:
        coordinates = [Vector((0.0, 0.0, 0.0))]
    minimum = [min(point[axis] for point in coordinates) for axis in range(3)]
    maximum = [max(point[axis] for point in coordinates) for axis in range(3)]
    return {
        "min": [round(value, 6) for value in minimum],
        "max": [round(value, 6) for value in maximum],
    }


def transform_contract(obj: bpy.types.Object) -> dict[str, list[float]]:
    quaternion = obj.rotation_euler.to_quaternion()
    return {
        "translation": [round(float(value), 6) for value in obj.location],
        "rotationQuaternion": [round(float(value), 6) for value in (quaternion.w, quaternion.x, quaternion.y, quaternion.z)],
        "scale": [round(float(value), 6) for value in obj.scale],
    }


def mesh_statistics() -> dict[str, object]:
    per_mesh: dict[str, dict[str, int]] = {}
    total_vertices = 0
    total_polygons = 0
    total_triangles = 0
    for obj in sorted((obj for obj in bpy.data.objects if obj.type == "MESH"), key=lambda item: item.name):
        obj.data.calc_loop_triangles()
        vertices = len(obj.data.vertices)
        polygons = len(obj.data.polygons)
        triangles = len(obj.data.loop_triangles)
        per_mesh[obj.name] = {"vertices": vertices, "polygons": polygons, "triangles": triangles}
        total_vertices += vertices
        total_polygons += polygons
        total_triangles += triangles
    return {
        "meshCount": len(per_mesh),
        "vertices": total_vertices,
        "polygons": total_polygons,
        "triangles": total_triangles,
        "perMesh": per_mesh,
    }


def material_assignments() -> dict[str, list[str]]:
    assignments: dict[str, list[str]] = {}
    for obj in sorted((obj for obj in bpy.data.objects if obj.type == "MESH"), key=lambda item: item.name):
        assignments[obj.name] = [slot.material.name for slot in obj.material_slots if slot.material]
    return assignments


def collect_named_poses() -> dict[str, dict[str, object]]:
    poses: dict[str, dict[str, object]] = {}
    scene = bpy.context.scene
    for pose_name, (node_name, action_name, frame) in NAMED_POSE_SPECS.items():
        obj = bpy.data.objects[node_name]
        action = bpy.data.actions[action_name]
        animation_data = obj.animation_data_create()
        animation_data.action = action
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        poses[pose_name] = {
            "node": node_name,
            "action": action_name,
            "frame": frame,
            "transform": transform_contract(obj),
        }
    scene.frame_set(1)
    bpy.context.view_layer.update()
    return poses


def skin_weight_summary(skin: bpy.types.Object) -> dict[str, object]:
    group_names = {group.index: group.name for group in skin.vertex_groups}
    group_vertex_counts = {name: 0 for name in JOINT_NAMES}
    weighted_vertices = 0
    maximum_influences = 0
    totals: list[float] = []
    for vertex in skin.data.vertices:
        influences = [
            (group_names.get(element.group), float(element.weight))
            for element in vertex.groups
            if group_names.get(element.group) in group_vertex_counts and element.weight > 1.0e-8
        ]
        if influences:
            weighted_vertices += 1
            totals.append(sum(weight for _, weight in influences))
            maximum_influences = max(maximum_influences, len(influences))
            for name, _ in influences:
                assert name is not None
                group_vertex_counts[name] += 1
    return {
        "vertexCount": len(skin.data.vertices),
        "weightedVertexCount": weighted_vertices,
        "maxInfluencesPerVertex": maximum_influences,
        "minWeightSum": round(min(totals), 6) if totals else 0.0,
        "maxWeightSum": round(max(totals), 6) if totals else 0.0,
        "groupVertexCounts": group_vertex_counts,
    }


def corrective_shape_summary(skin: bpy.types.Object) -> list[dict[str, object]]:
    if skin.data.shape_keys is None:
        return []
    basis = skin.data.shape_keys.key_blocks.get("Basis")
    if basis is None:
        return []
    ring_vertex_count = len(basis.data) - 2
    ring_count = ring_vertex_count // HOSE_SIDES
    centers = []
    for ring_index in range(ring_count):
        center = Vector((0.0, 0.0, 0.0))
        for side in range(HOSE_SIDES):
            center += basis.data[ring_index * HOSE_SIDES + side].co
        centers.append(center / HOSE_SIDES)

    summaries: list[dict[str, object]] = []
    for shape_index, name in enumerate(CORRECTIVE_SHAPE_NAMES):
        shape = skin.data.shape_keys.key_blocks[name]
        support: list[int] = []
        inward_count = 0
        maximum = 0.0
        squared_sum = 0.0
        for vertex_index, (base_point, shape_point) in enumerate(zip(basis.data, shape.data)):
            delta = shape_point.co - base_point.co
            magnitude = delta.length
            if magnitude <= 1.0e-7:
                continue
            support.append(vertex_index)
            maximum = max(maximum, magnitude)
            squared_sum += magnitude * magnitude
            if vertex_index < ring_vertex_count:
                ring_index = vertex_index // HOSE_SIDES
                radial = base_point.co - centers[ring_index]
                if radial.length > 1.0e-8 and delta.dot(radial) < 0.0:
                    inward_count += 1
        nonzero = len(support)
        summaries.append(
            {
                "name": name,
                "index": shape_index,
                "nonzeroVertexCount": nonzero,
                "supportFraction": round(nonzero / len(basis.data), 6),
                "inwardFraction": round(inward_count / nonzero, 6) if nonzero else 0.0,
                "maxDeltaMeters": round(maximum, 7),
                "rmsDeltaMeters": round(math.sqrt(squared_sum / nonzero), 7) if nonzero else 0.0,
                "supportSHA256": hashlib.sha256(struct.pack(f"<{len(support)}I", *support)).hexdigest(),
            }
        )
    return summaries


def scene_semantic_payload(named_poses: dict[str, dict[str, object]]) -> dict[str, object]:
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "runtimeNodes": sorted(RUNTIME_NODES),
        "joints": JOINT_NAMES,
        "materials": sorted(MATERIAL_NAMES),
        "localBounds": {name: local_bounds(bpy.data.objects[name]) for name in sorted(RUNTIME_NODES)},
        "meshStats": mesh_statistics(),
        "materialAssignments": material_assignments(),
        "namedPoses": named_poses,
        "skinWeights": skin_weight_summary(bpy.data.objects["VAC_HOSE_SKIN"]),
        "correctiveBlendShapes": corrective_shape_summary(bpy.data.objects["VAC_HOSE_SKIN"]),
    }


def semantic_sha256(payload: dict[str, object]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def matrix_column_major_values(matrix: Matrix) -> list[float]:
    return [float(matrix[row][column]) for column in range(4) for row in range(4)]


def write_hose_mesh_binary(path: Path, skin: bpy.types.Object, armature: bpy.types.Object) -> dict[str, object]:
    mesh = skin.data
    mesh.update()
    mesh.calc_loop_triangles()
    vertex_count = len(mesh.vertices)
    indices = [int(vertex) for triangle in mesh.loop_triangles for vertex in triangle.vertices]
    index_count = len(indices)
    joint_count = len(JOINT_NAMES)
    corrective_count = len(CORRECTIVE_SHAPE_NAMES)

    uv_layer = mesh.uv_layers.active
    if uv_layer is None:
        raise RuntimeError("VAC_HOSE_SKIN requires an active UV layer for Metal export")
    uvs: list[tuple[float, float] | None] = [None] * vertex_count
    for loop in mesh.loops:
        if uvs[loop.vertex_index] is None:
            uv = uv_layer.data[loop.index].uv
            uvs[loop.vertex_index] = (float(uv.x), float(uv.y))
    if any(uv is None for uv in uvs):
        raise RuntimeError("VAC_HOSE_SKIN contains a vertex without UV coordinates")

    group_names = {group.index: group.name for group in skin.vertex_groups}
    joint_lookup = {name: index for index, name in enumerate(JOINT_NAMES)}
    packed_joint_indices: list[tuple[int, int]] = []
    packed_joint_weights: list[tuple[float, float]] = []
    for vertex in mesh.vertices:
        influences = sorted(
            (
                (joint_lookup[group_names[element.group]], float(element.weight))
                for element in vertex.groups
                if group_names.get(element.group) in joint_lookup and element.weight > 1.0e-8
            ),
            key=lambda item: item[0],
        )
        if not 1 <= len(influences) <= 2:
            raise RuntimeError(f"vertex {vertex.index} has {len(influences)} Metal skin influences")
        total = sum(weight for _, weight in influences)
        if not math.isclose(total, 1.0, abs_tol=1.0e-5):
            raise RuntimeError(f"vertex {vertex.index} weights sum to {total}")
        first_joint, first_weight = influences[0]
        if len(influences) == 2:
            second_joint, second_weight = influences[1]
        else:
            second_joint, second_weight = first_joint, 0.0
        packed_joint_indices.append((first_joint, second_joint))
        packed_joint_weights.append((first_weight / total, second_weight / total))

    shape_keys = mesh.shape_keys
    if shape_keys is None or shape_keys.key_blocks.get("Basis") is None:
        raise RuntimeError("VAC_HOSE_SKIN requires corrective shape keys")
    basis = shape_keys.key_blocks["Basis"]
    corrective_deltas = []
    for name in CORRECTIVE_SHAPE_NAMES:
        shape = shape_keys.key_blocks.get(name)
        if shape is None:
            raise RuntimeError(f"VAC_HOSE_SKIN is missing {name}")
        corrective_deltas.append([shape.data[index].co - basis.data[index].co for index in range(vertex_count)])

    payload = bytearray()
    offsets: dict[str, int] = {}

    def begin_section(name: str) -> None:
        offsets[name] = MESH_BINARY_HEADER_BYTES + len(payload)

    begin_section("positionsOffset")
    for vertex in mesh.vertices:
        payload.extend(struct.pack("<3f", *map(float, vertex.co)))
    begin_section("normalsOffset")
    for vertex in mesh.vertices:
        payload.extend(struct.pack("<3f", *map(float, vertex.normal)))
    begin_section("textureCoordinatesOffset")
    for uv in uvs:
        assert uv is not None
        payload.extend(struct.pack("<2f", *uv))
    begin_section("jointIndicesOffset")
    for joints in packed_joint_indices:
        payload.extend(struct.pack("<2H", *joints))
    begin_section("jointWeightsOffset")
    for weights in packed_joint_weights:
        payload.extend(struct.pack("<2f", *weights))
    begin_section("indicesOffset")
    payload.extend(struct.pack(f"<{index_count}I", *indices))
    begin_section("bindMatricesOffset")
    bind_matrices = [armature.data.bones[name].matrix_local.copy() for name in JOINT_NAMES]
    for matrix in bind_matrices:
        payload.extend(struct.pack("<16f", *matrix_column_major_values(matrix)))
    begin_section("inverseBindMatricesOffset")
    for matrix in bind_matrices:
        payload.extend(struct.pack("<16f", *matrix_column_major_values(matrix.inverted_safe())))
    begin_section("correctiveDeltasOffset")
    for deltas in corrective_deltas:
        for delta in deltas:
            payload.extend(struct.pack("<3f", *map(float, delta)))
    begin_section("materialOffset")
    material = skin.material_slots[0].material
    if material is None or not material.use_nodes:
        raise RuntimeError("VAC_HOSE_SKIN requires its authored PBR material")
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled is None:
        raise RuntimeError("VAC_HOSE_SKIN material requires Principled BSDF")
    base_color = tuple(float(value) for value in principled.inputs["Base Color"].default_value)
    material_values = (
        *base_color,
        float(principled.inputs["Metallic"].default_value),
        float(principled.inputs["Roughness"].default_value),
        float(principled.inputs["Coat Weight"].default_value),
        float(principled.inputs["Coat Roughness"].default_value),
    )
    payload.extend(struct.pack("<8f", *material_values))

    file_byte_count = MESH_BINARY_HEADER_BYTES + len(payload)
    header = bytearray(MESH_BINARY_HEADER_BYTES)
    header[:8] = MESH_BINARY_MAGIC
    struct.pack_into(
        "<20I",
        header,
        8,
        MESH_BINARY_VERSION,
        MESH_BINARY_ENDIAN_MARKER,
        MESH_BINARY_HEADER_BYTES,
        file_byte_count,
        vertex_count,
        index_count,
        joint_count,
        corrective_count,
        offsets["positionsOffset"],
        offsets["normalsOffset"],
        offsets["textureCoordinatesOffset"],
        offsets["jointIndicesOffset"],
        offsets["jointWeightsOffset"],
        offsets["indicesOffset"],
        offsets["bindMatricesOffset"],
        offsets["inverseBindMatricesOffset"],
        offsets["correctiveDeltasOffset"],
        offsets["materialOffset"],
        MESH_BINARY_HEADER_BYTES,
        len(payload),
    )
    positions = [vertex.co for vertex in mesh.vertices]
    bounds_min = [min(position[axis] for position in positions) for axis in range(3)]
    bounds_max = [max(position[axis] for position in positions) for axis in range(3)]
    struct.pack_into("<6f", header, 88, *bounds_min, *bounds_max)
    header[112:144] = hashlib.sha256(payload).digest()
    struct.pack_into("<4I", header, 144, 0x00000003, 4, 2, 0)
    path.write_bytes(header + payload)
    return {
        "schema": "VoiceVACHoseMesh",
        "version": MESH_BINARY_VERSION,
        "endianness": "little",
        "headerByteCount": MESH_BINARY_HEADER_BYTES,
        "positionComponentType": "float32",
        "normalComponentType": "float32",
        "textureCoordinateComponentType": "float32",
        "indexComponentType": "uint32",
        "jointIndexComponentType": "uint16",
        "jointWeightComponentType": "float32",
        "matrixComponentType": "float32",
        "matrixLayout": "columnMajor4x4",
        "sha256": sha256(path),
        "byteCount": path.stat().st_size,
        "vertexCount": vertex_count,
        "indexCount": index_count,
        "jointCount": joint_count,
        "maxInfluencesPerVertex": 2,
        "correctiveBlendShapes": corrective_shape_summary(skin),
        "sections": offsets,
        "payloadSHA256": hashlib.sha256(payload).hexdigest(),
        "bounds": {
            "min": [round(float(value), 7) for value in bounds_min],
            "max": [round(float(value), 7) for value in bounds_max],
        },
    }


def write_contract(
    path: Path,
    blend_path: Path,
    device_usdz: Path,
    hose_usdz: Path,
    hose_mesh_binary: Path,
    hose_binary_contract: dict[str, object],
    device: dict[str, bpy.types.Object],
) -> None:
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    named_poses = collect_named_poses()
    bounds = {name: local_bounds(bpy.data.objects[name]) for name in RUNTIME_NODES}
    weight_summary = skin_weight_summary(bpy.data.objects["VAC_HOSE_SKIN"])
    semantic_payload = scene_semantic_payload(named_poses)
    builder_path = Path(__file__).resolve()
    contract = {
        "schemaVersion": SCHEMA_VERSION,
        "product": "Voice VAC",
        "assetSet": "native-game-prop-v2-metal-hose",
        "units": {"linear": "meter", "metersPerUnit": 1.0},
        "axes": {"forward": "-Z", "up": "Y", "authoringUp": "Z"},
        "runtimeNodes": RUNTIME_NODES,
        "joints": JOINT_NAMES,
        "jointOrder": "root-to-tip",
        "materials": MATERIAL_NAMES,
        "materialAssignments": material_assignments(),
        "localBounds": bounds,
        "nominalDockTransform": named_poses["nozzleDocked"]["transform"],
        "nozzlePivot": named_poses["nozzleDocked"]["transform"],
        "buttonTravelMeters": BUTTON_TRAVEL_METERS,
        "runtimePoseDelivery": {
            "mode": "namedTransforms",
            "usdzAnimationTimeSamples": False,
            "source": "evaluated Blender actions copied into stable runtime transforms",
            "namedPoses": named_poses,
        },
        "authoringActions": sorted(action.name for action in bpy.data.actions if action.name in {"VAC_NOZZLE_POSES", "VAC_BUTTON_POSES", "VAC_HOSE_POSES"}),
        "poseFrames": {
            "nozzleVerticalDock": 1,
            "nozzleLiftRotate": 10,
            "nozzleHorizontalDeploy": 24,
            "attachmentCompression": 36,
            "buttonUp": 1,
            "buttonReady": 10,
            "buttonDown": 20,
            "buttonPaused": 30,
            "hoseRest": 1,
            "hoseSuctionPulse": 24,
        },
        "meshStats": mesh_statistics(),
        "skinWeights": weight_summary,
        "correctiveBlendShapes": corrective_shape_summary(bpy.data.objects["VAC_HOSE_SKIN"]),
        "hoseRuntime": {
            "renderer": "metalSkinning",
            "surface": "transparentMTKView",
            "realityKitSkeletonTokensAreEntities": False,
            "realityKitUSDZRole": "static-loadability-and-authoring-diagnostic-only",
            "binary": hose_binary_contract,
        },
        "reproducibility": {
            "mode": "semantic-contract-v1",
            "sceneSemanticSHA256": semantic_sha256(semantic_payload),
            "statement": "Normalized scene semantics are reproducible; Blender and USD container bytes are not promised identical.",
        },
        "sourceHashes": {
            "build_voice_vac.py": sha256(builder_path),
            "voice-vac-machine.blend": sha256(blend_path),
        },
        "exports": {
            device_usdz.name: {"sha256": sha256(device_usdz), "byteCount": device_usdz.stat().st_size},
            hose_usdz.name: {"sha256": sha256(hose_usdz), "byteCount": hose_usdz.stat().st_size},
            hose_mesh_binary.name: {"sha256": sha256(hose_mesh_binary), "byteCount": hose_mesh_binary.stat().st_size},
        },
    }
    path.write_text(json.dumps(contract, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    clear_scene()
    configure_scene()
    materials = build_materials()
    device_collection = create_collection("VOICE_VAC_DEVICE")
    hose_collection = create_collection("VOICE_VAC_HOSE")
    device = build_device(device_collection, materials)
    hose = build_hose(hose_collection, materials)
    build_actions(device, hose)

    blend_path = output_dir / "voice-vac-machine.blend"
    device_usdz = output_dir / "VoiceVACDevice.usdz"
    hose_usdz = output_dir / "VoiceVACHose.usdz"
    hose_mesh_binary = output_dir / "VoiceVACHose.meshbin"
    diagnostic_glb = output_dir / "voice-vac-machine.glb"
    contract_path = output_dir / "asset-contract.json"

    bpy.context.scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), check_existing=False)
    export_usdz(device_usdz, [device["device_root"]], "/VoiceVACDevice")
    export_usdz(hose_usdz, [hose["hose_root"]], "/VoiceVACHose")
    export_diagnostic_glb(diagnostic_glb, [device["device_root"], hose["hose_root"]])
    hose_binary_contract = write_hose_mesh_binary(hose_mesh_binary, hose["hose_skin"], hose["hose_root"])
    write_contract(
        contract_path,
        blend_path,
        device_usdz,
        hose_usdz,
        hose_mesh_binary,
        hose_binary_contract,
        device,
    )
    stats = mesh_statistics()
    print(
        "Voice VAC production assets written: "
        f"{stats['meshCount']} meshes, {stats['vertices']} vertices, "
        f"{stats['triangles']} triangles, 64 joints"
    )
    print(f"Blend: {blend_path}")
    print(f"Device USDZ: {device_usdz}")
    print(f"Hose USDZ: {hose_usdz}")
    print(f"Metal hose mesh: {hose_mesh_binary}")
    print(f"Contract: {contract_path}")


def main() -> None:
    args = parse_args()
    build(args.output_dir.resolve())


if __name__ == "__main__":
    main()
