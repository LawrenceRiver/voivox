#!/usr/bin/env python3
"""Validate the production Voice VAC Blender and RealityKit asset contract.

The validator intentionally has no dependency outside Blender's Python runtime.
It validates the authoring scene first, then the JSON/USDZ export contract, and
optionally the rendered transparent preview.  It is designed to fail loudly on
the retired Electron-era primitive asset.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import struct
import subprocess
import sys
from pathlib import Path
from typing import Iterable

import bpy
from mathutils import Matrix, Vector


REQUIRED_OBJECTS = {
    "VAC_DEVICE_ROOT",
    "VAC_PORT",
    "VAC_NOZZLE",
    "VAC_NOZZLE_DUCKBILL",
    "VAC_NOZZLE_TIP",
    "VAC_BUTTON_BASE",
    "VAC_BUTTON_CAP",
    "VAC_HOSE_ROOT",
    "VAC_HOSE_SKIN",
}
REQUIRED_JOINTS = [f"VAC_HOSE_JOINT_{index:02d}" for index in range(64)]
REQUIRED_MATERIALS = {
    "MAT_PEARL_PLASTIC",
    "MAT_PEARL_RIBBED",
    "MAT_TOY_IVORY",
    "MAT_CHARCOAL_RUBBER",
    "MAT_BUTTON_RED",
    "MAT_MOUTH_DARK",
    "MAT_EYE_WHITE",
    "MAT_EYE_DARK",
}
REQUIRED_TOY_EYES = {
    "VAC_NOZZLE_EYE_L",
    "VAC_NOZZLE_EYE_R",
    "VAC_NOZZLE_PUPIL_L",
    "VAC_NOZZLE_PUPIL_R",
}
REQUIRED_MESH_OBJECTS = {
    "VAC_PORT",
    "VAC_NOZZLE_TIP",
    "VAC_BUTTON_BASE",
    "VAC_BUTTON_CAP",
    "VAC_HOSE_SKIN",
}
REQUIRED_ACTIONS = {
    "VAC_NOZZLE_POSES",
    "VAC_BUTTON_POSES",
    "VAC_HOSE_POSES",
}
REQUIRED_CORRECTIVE_SHAPES = ("bendPositive", "bendNegative")
MESH_BINARY_MAGIC = b"VACHOSE\0"
MESH_BINARY_VERSION = 1
MESH_BINARY_HEADER_BYTES = 160
MESH_BINARY_ENDIAN_MARKER = 0x01020304
EXPECTED_SCHEMA_VERSION = 2
EXPECTED_PREVIEW_SIZE = (1800, 1100)
EXPECTED_DOCK_TRANSLATION = (-0.132, -0.037, 0.002)
# Docked, the mouth points toward the camera and its long axis is vertical.
EXPECTED_DOCK_ROTATION = (0.5, -0.5, -0.5, 0.5)
EXPECTED_BUTTON_UP_TRANSLATION = (0.128, 0.006, 0.002)
EXPECTED_BUTTON_TRAVEL_METERS = 0.009
REQUIRED_NAMED_POSES = {
    "nozzleDocked": ("VAC_NOZZLE", "VAC_NOZZLE_POSES", 1),
    "nozzleLiftRotate": ("VAC_NOZZLE", "VAC_NOZZLE_POSES", 10),
    "nozzleDeployed": ("VAC_NOZZLE", "VAC_NOZZLE_POSES", 24),
    "nozzleAttachmentCompression": ("VAC_NOZZLE", "VAC_NOZZLE_POSES", 36),
    "buttonUp": ("VAC_BUTTON_CAP", "VAC_BUTTON_POSES", 1),
    "buttonReady": ("VAC_BUTTON_CAP", "VAC_BUTTON_POSES", 10),
    "buttonDown": ("VAC_BUTTON_CAP", "VAC_BUTTON_POSES", 20),
    "buttonPaused": ("VAC_BUTTON_CAP", "VAC_BUTTON_POSES", 30),
}


class Validation:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.notes: list[str] = []

    def require(self, condition: bool, message: str) -> None:
        if not condition:
            self.errors.append(message)

    def note(self, message: str) -> None:
        self.notes.append(message)


def parse_args() -> argparse.Namespace:
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path)
    parser.add_argument("--preview", type=Path)
    parser.add_argument("--skip-exports", action="store_true")
    return parser.parse_args(arguments)


def finite(values: Iterable[float]) -> bool:
    return all(math.isfinite(float(value)) for value in values)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def descendants(root: bpy.types.Object) -> set[str]:
    names: set[str] = set()
    stack = list(root.children)
    while stack:
        child = stack.pop()
        names.add(child.name)
        stack.extend(child.children)
    return names


def rounded(values: Iterable[float]) -> list[float]:
    return [round(float(value), 6) for value in values]


def transform_contract(obj: bpy.types.Object) -> dict[str, list[float]]:
    quaternion = obj.rotation_euler.to_quaternion()
    return {
        "translation": rounded(obj.location),
        "rotationQuaternion": rounded((quaternion.w, quaternion.x, quaternion.y, quaternion.z)),
        "scale": rounded(obj.scale),
    }


def transforms_close(left: object, right: object, tolerance: float = 1.0e-5) -> bool:
    if not is_transform(left) or not is_transform(right):
        return False
    assert isinstance(left, dict) and isinstance(right, dict)
    for key in ("translation", "scale"):
        if any(abs(float(a) - float(b)) > tolerance for a, b in zip(left[key], right[key])):
            return False
    left_rotation = [float(value) for value in left["rotationQuaternion"]]
    right_rotation = [float(value) for value in right["rotationQuaternion"]]
    direct = max(abs(a - b) for a, b in zip(left_rotation, right_rotation))
    negated = max(abs(a + b) for a, b in zip(left_rotation, right_rotation))
    return min(direct, negated) <= tolerance


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
    return {
        "min": rounded(min(point[axis] for point in coordinates) for axis in range(3)),
        "max": rounded(max(point[axis] for point in coordinates) for axis in range(3)),
    }


def bounds_close(left: object, right: object, tolerance: float = 1.0e-5) -> bool:
    if not is_bounds(left) or not is_bounds(right):
        return False
    assert isinstance(left, dict) and isinstance(right, dict)
    return all(
        abs(float(a) - float(b)) <= tolerance
        for key in ("min", "max")
        for a, b in zip(left[key], right[key])
    )


def collect_named_poses(check: Validation | None = None) -> dict[str, dict[str, object]]:
    poses: dict[str, dict[str, object]] = {}
    scene = bpy.context.scene
    for pose_name, (node_name, action_name, frame) in REQUIRED_NAMED_POSES.items():
        obj = bpy.data.objects.get(node_name)
        action = bpy.data.actions.get(action_name)
        if obj is None or action is None:
            if check is not None:
                check.require(False, f"cannot evaluate {pose_name}: missing {node_name} or {action_name}")
            continue
        animation_data = obj.animation_data_create()
        try:
            animation_data.action = action
        except RuntimeError as error:
            if check is not None:
                check.require(False, f"cannot bind {action_name} to {node_name}: {error}")
            continue
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
    group_vertex_counts = {name: 0 for name in REQUIRED_JOINTS}
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
    if ring_vertex_count <= 0 or ring_vertex_count % 28:
        return []
    ring_count = ring_vertex_count // 28
    centers = []
    for ring_index in range(ring_count):
        center = Vector((0.0, 0.0, 0.0))
        for side in range(28):
            center += basis.data[ring_index * 28 + side].co
        centers.append(center / 28.0)

    summaries: list[dict[str, object]] = []
    for shape_index, name in enumerate(REQUIRED_CORRECTIVE_SHAPES):
        shape = skin.data.shape_keys.key_blocks.get(name)
        if shape is None:
            continue
        nonzero = 0
        inward = 0
        maximum = 0.0
        squared_sum = 0.0
        support: list[int] = []
        for vertex_index, (base_point, shape_point) in enumerate(zip(basis.data, shape.data)):
            delta = shape_point.co - base_point.co
            magnitude = delta.length
            if magnitude <= 1.0e-7:
                continue
            nonzero += 1
            support.append(vertex_index)
            maximum = max(maximum, magnitude)
            squared_sum += magnitude * magnitude
            if vertex_index < ring_vertex_count:
                ring_index = vertex_index // 28
                radial = base_point.co - centers[ring_index]
                if radial.length > 1.0e-8 and delta.dot(radial) < 0.0:
                    inward += 1
        summaries.append(
            {
                "name": name,
                "index": shape_index,
                "nonzeroVertexCount": nonzero,
                "supportFraction": round(nonzero / len(basis.data), 6),
                "inwardFraction": round(inward / nonzero, 6) if nonzero else 0.0,
                "maxDeltaMeters": round(maximum, 7),
                "rmsDeltaMeters": round(math.sqrt(squared_sum / nonzero), 7) if nonzero else 0.0,
                "supportSHA256": hashlib.sha256(struct.pack(f"<{len(support)}I", *support)).hexdigest(),
            }
        )
    return summaries


def mesh_statistics() -> dict[str, object]:
    per_mesh: dict[str, dict[str, int]] = {}
    total_vertices = 0
    total_polygons = 0
    total_triangles = 0
    for obj in sorted((obj for obj in bpy.data.objects if obj.type == "MESH"), key=lambda item: item.name):
        obj.data.calc_loop_triangles()
        entry = {
            "vertices": len(obj.data.vertices),
            "polygons": len(obj.data.polygons),
            "triangles": len(obj.data.loop_triangles),
        }
        per_mesh[obj.name] = entry
        total_vertices += entry["vertices"]
        total_polygons += entry["polygons"]
        total_triangles += entry["triangles"]
    return {
        "meshCount": len(per_mesh),
        "vertices": total_vertices,
        "polygons": total_polygons,
        "triangles": total_triangles,
        "perMesh": per_mesh,
    }


def material_assignments() -> dict[str, list[str]]:
    return {
        obj.name: [slot.material.name for slot in obj.material_slots if slot.material]
        for obj in sorted((obj for obj in bpy.data.objects if obj.type == "MESH"), key=lambda item: item.name)
    }


def scene_semantic_payload(named_poses: dict[str, dict[str, object]]) -> dict[str, object]:
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    skin = bpy.data.objects.get("VAC_HOSE_SKIN")
    return {
        "schemaVersion": EXPECTED_SCHEMA_VERSION,
        "runtimeNodes": sorted(REQUIRED_OBJECTS),
        "joints": REQUIRED_JOINTS,
        "materials": sorted(REQUIRED_MATERIALS),
        "localBounds": {name: local_bounds(bpy.data.objects[name]) for name in sorted(REQUIRED_OBJECTS)},
        "meshStats": mesh_statistics(),
        "materialAssignments": material_assignments(),
        "namedPoses": named_poses,
        "skinWeights": skin_weight_summary(skin) if skin is not None and skin.type == "MESH" else None,
        "correctiveBlendShapes": corrective_shape_summary(skin) if skin is not None and skin.type == "MESH" else None,
    }


def semantic_sha256(payload: dict[str, object]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def validate_scene(check: Validation) -> dict[str, int]:
    object_names = {obj.name for obj in bpy.data.objects}
    missing_objects = REQUIRED_OBJECTS - object_names
    check.require(not missing_objects, f"missing required scene nodes: {sorted(missing_objects)}")

    missing_eyes = REQUIRED_TOY_EYES - object_names
    check.require(not missing_eyes, f"missing toy eye meshes: {sorted(missing_eyes)}")

    collar = bpy.data.objects.get("VAC_NOZZLE_COLLAR")
    if collar is not None:
        check.require(
            collar.get("voice_vac_connector_role") == "hose_capture",
            "VAC_NOZZLE_COLLAR must declare its hose-capture role",
        )
        collar_extents = [
            max(corner[axis] for corner in collar.bound_box) - min(corner[axis] for corner in collar.bound_box)
            for axis in range(3)
        ]
        check.require(max(collar_extents) >= 0.080, "hose-capture collar must be wider than the largest 52 mm hose rib")
        check.require(min(collar_extents) >= 0.034, "hose-capture collar must be long enough to visibly overlap the hose")

    for name in sorted(REQUIRED_TOY_EYES):
        applique = bpy.data.objects.get(name)
        if applique is None:
            continue
        check.require(
            applique.get("voice_vac_eye_style") == "applique",
            f"{name} must declare applique eye styling",
        )
        extents = [
            max(corner[axis] for corner in applique.bound_box) - min(corner[axis] for corner in applique.bound_box)
            for axis in range(3)
        ]
        check.require(
            min(extents) / max(extents) < 0.35,
            f"{name} must be a shallow pasted-on mesh rather than a sphere",
        )

    for suffix in ("L", "R"):
        eye = bpy.data.objects.get(f"VAC_NOZZLE_EYE_{suffix}")
        pupil = bpy.data.objects.get(f"VAC_NOZZLE_PUPIL_{suffix}")
        if eye is None or pupil is None:
            continue
        eye_extents = [
            max(corner[axis] for corner in eye.bound_box) - min(corner[axis] for corner in eye.bound_box)
            for axis in range(3)
        ]
        pupil_extents = [
            max(corner[axis] for corner in pupil.bound_box) - min(corner[axis] for corner in pupil.bound_box)
            for axis in range(3)
        ]
        check.require(max(eye_extents) >= 0.032, f"eye {suffix} applique must remain readable at desktop scale")
        check.require(max(pupil_extents) >= 0.014, f"pupil {suffix} applique must remain readable at desktop scale")
        check.require(
            pupil.location.z >= eye.location.z + 0.003,
            f"pupil {suffix} must sit fully above the eye applique instead of intersecting it",
        )

    for name in REQUIRED_OBJECTS:
        check.require(sum(obj.name == name for obj in bpy.data.objects) == 1, f"scene node {name} must exist exactly once")

    missing_materials = REQUIRED_MATERIALS - set(bpy.data.materials.keys())
    check.require(not missing_materials, f"missing stable materials: {sorted(missing_materials)}")
    toy_ivory = bpy.data.materials.get("MAT_TOY_IVORY")
    eye_white = bpy.data.materials.get("MAT_EYE_WHITE")
    if toy_ivory is not None and eye_white is not None:
        toy_value = sum(float(channel) for channel in toy_ivory.diffuse_color[:3]) / 3.0
        eye_value = sum(float(channel) for channel in eye_white.diffuse_color[:3]) / 3.0
        check.require(
            eye_value - toy_value >= 0.30,
            "white eye appliques must visibly separate from the warm ivory nozzle at desktop scale",
        )

    missing_actions = REQUIRED_ACTIONS - set(bpy.data.actions.keys())
    check.require(not missing_actions, f"missing deterministic pose actions: {sorted(missing_actions)}")

    expected_bindings = {
        "VAC_NOZZLE": "VAC_NOZZLE_POSES",
        "VAC_BUTTON_CAP": "VAC_BUTTON_POSES",
        "VAC_HOSE_ROOT": "VAC_HOSE_POSES",
    }
    for node_name, action_name in expected_bindings.items():
        obj = bpy.data.objects.get(node_name)
        active_action = obj.animation_data.action if obj is not None and obj.animation_data is not None else None
        check.require(
            active_action is not None and active_action.name == action_name,
            f"{node_name} must retain active {action_name} authoring evaluation",
        )

    expected_dock = {
        "translation": rounded(EXPECTED_DOCK_TRANSLATION),
        "rotationQuaternion": rounded(EXPECTED_DOCK_ROTATION),
        "scale": [1.0, 1.0, 1.0],
    }
    expected_button_up = {
        "translation": rounded(EXPECTED_BUTTON_UP_TRANSLATION),
        "rotationQuaternion": [1.0, 0.0, 0.0, 0.0],
        "scale": [1.0, 1.0, 1.0],
    }
    loaded_nozzle = bpy.data.objects.get("VAC_NOZZLE")
    loaded_button = bpy.data.objects.get("VAC_BUTTON_CAP")
    if loaded_nozzle is not None:
        check.require(transforms_close(transform_contract(loaded_nozzle), expected_dock), "saved .blend must open in the true docked nozzle rest pose")
    if loaded_button is not None:
        check.require(transforms_close(transform_contract(loaded_button), expected_button_up), "saved .blend must open with the red button fully up")

    named_poses = collect_named_poses(check)
    if "nozzleDocked" in named_poses:
        check.require(transforms_close(named_poses["nozzleDocked"]["transform"], expected_dock), "VAC_NOZZLE_POSES frame 1 must evaluate to the true docked pose")
    if "buttonUp" in named_poses:
        check.require(transforms_close(named_poses["buttonUp"]["transform"], expected_button_up), "VAC_BUTTON_POSES frame 1 must evaluate to button-up")
    for left, right in (
        ("nozzleDocked", "nozzleLiftRotate"),
        ("nozzleLiftRotate", "nozzleDeployed"),
        ("nozzleDeployed", "nozzleAttachmentCompression"),
        ("buttonUp", "buttonReady"),
        ("buttonReady", "buttonDown"),
        ("buttonDown", "buttonPaused"),
    ):
        if left in named_poses and right in named_poses:
            check.require(
                not transforms_close(named_poses[left]["transform"], named_poses[right]["transform"]),
                f"authoring poses {left} and {right} must evaluate to distinct transforms",
            )
    if "buttonUp" in named_poses and "buttonDown" in named_poses:
        up_y = float(named_poses["buttonUp"]["transform"]["translation"][1])
        down_y = float(named_poses["buttonDown"]["transform"]["translation"][1])
        check.require(
            math.isclose(down_y - up_y, EXPECTED_BUTTON_TRAVEL_METERS, abs_tol=1.0e-6),
            "buttonDown must travel exactly 9 mm from buttonUp",
        )

    unit_settings = bpy.context.scene.unit_settings
    check.require(unit_settings.system == "METRIC", "scene unit system must be METRIC")
    check.require(unit_settings.length_unit == "METERS", "scene length unit must be METERS")
    check.require(math.isclose(unit_settings.scale_length, 1.0), "scene scale_length must be 1 meter")
    check.require(bpy.context.scene.get("voice_vac_forward_axis") == "-Z", "scene must declare -Z forward")
    check.require(bpy.context.scene.get("voice_vac_up_axis") == "Y", "scene must declare Y-up runtime export")

    device_root = bpy.data.objects.get("VAC_DEVICE_ROOT")
    hose_root = bpy.data.objects.get("VAC_HOSE_ROOT")
    hose_skin = bpy.data.objects.get("VAC_HOSE_SKIN")
    if device_root is not None:
        device_children = descendants(device_root)
        for name in ("VAC_PORT", "VAC_NOZZLE", "VAC_NOZZLE_TIP", "VAC_BUTTON_BASE", "VAC_BUTTON_CAP"):
            check.require(name in device_children, f"{name} must descend from VAC_DEVICE_ROOT")

    if hose_root is not None:
        check.require(hose_root.type == "ARMATURE", "VAC_HOSE_ROOT must be an armature object")
        if hose_root.type == "ARMATURE":
            bone_names = [bone.name for bone in hose_root.data.bones]
            check.require(bone_names == REQUIRED_JOINTS, "hose bones must be the ordered VAC_HOSE_JOINT_00...63 chain")
            for index, name in enumerate(REQUIRED_JOINTS):
                bone = hose_root.data.bones.get(name)
                if bone is None:
                    continue
                expected_parent = None if index == 0 else REQUIRED_JOINTS[index - 1]
                actual_parent = bone.parent.name if bone.parent else None
                check.require(actual_parent == expected_parent, f"{name} parent must be {expected_parent!r}, got {actual_parent!r}")
                check.require((index == 0) or bone.use_connect, f"{name} must be connected to its parent")
    if hose_skin is not None and hose_root is not None:
        check.require(hose_skin.parent == hose_root, "VAC_HOSE_SKIN must be parented to VAC_HOSE_ROOT")
        armature_modifiers = [modifier for modifier in hose_skin.modifiers if modifier.type == "ARMATURE"]
        check.require(len(armature_modifiers) == 1, "VAC_HOSE_SKIN must have exactly one armature modifier")
        if armature_modifiers:
            check.require(armature_modifiers[0].object == hose_root, "hose armature modifier must target VAC_HOSE_ROOT")
        groups = {group.name for group in hose_skin.vertex_groups}
        check.require(groups == set(REQUIRED_JOINTS), "hose skin vertex groups must match the 64-joint contract")
        if hose_skin.type == "MESH":
            weight_summary = skin_weight_summary(hose_skin)
            check.require(
                weight_summary["weightedVertexCount"] == weight_summary["vertexCount"],
                "every hose vertex must have a non-empty joint weight assignment",
            )
            check.require(weight_summary["maxInfluencesPerVertex"] <= 2, "hose vertices may use at most two adjacent joint influences")
            check.require(math.isclose(float(weight_summary["minWeightSum"]), 1.0, abs_tol=1.0e-5), "minimum hose vertex weight sum must be 1")
            check.require(math.isclose(float(weight_summary["maxWeightSum"]), 1.0, abs_tol=1.0e-5), "maximum hose vertex weight sum must be 1")
            empty_groups = [name for name, count in weight_summary["groupVertexCounts"].items() if count == 0]
            check.require(not empty_groups, f"hose joint groups must all influence geometry: {empty_groups}")

            corrective_summary = corrective_shape_summary(hose_skin)
            check.require(
                [entry["name"] for entry in corrective_summary] == list(REQUIRED_CORRECTIVE_SHAPES),
                "VAC_HOSE_SKIN must provide deterministic bendPositive and bendNegative corrective shape keys",
            )
            for entry in corrective_summary:
                check.require(
                    int(entry["nonzeroVertexCount"]) >= 200,
                    f"corrective {entry['name']} must move a measurable set of high-curvature vertices",
                )
                check.require(
                    0.01 <= float(entry["supportFraction"]) <= 0.35,
                    f"corrective {entry['name']} must stay concentrated on the inner arc",
                )
                check.require(
                    float(entry["inwardFraction"]) >= 0.90,
                    f"corrective {entry['name']} deltas must predominantly compress toward the hose centerline",
                )
                check.require(
                    float(entry["maxDeltaMeters"]) >= 0.0005,
                    f"corrective {entry['name']} must contain a visible non-zero displacement",
                )
            if len(corrective_summary) == 2:
                check.require(
                    corrective_summary[0]["supportSHA256"] != corrective_summary[1]["supportSHA256"],
                    "positive and negative bend correctives must target different inner arcs",
                )

        hose_action = bpy.data.actions.get("VAC_HOSE_POSES")
        if hose_root.type == "ARMATURE" and hose_action is not None:
            animation_data = hose_root.animation_data_create()
            animation_data.action = hose_action
            bpy.context.scene.frame_set(1)
            rest_scales = [tuple(round(float(value), 6) for value in bone.scale) for bone in hose_root.pose.bones]
            bpy.context.scene.frame_set(24)
            pulse_scales = [tuple(round(float(value), 6) for value in bone.scale) for bone in hose_root.pose.bones]
            check.require(rest_scales != pulse_scales, "VAC_HOSE_POSES must evaluate a distinct suction pulse")
            bpy.context.scene.frame_set(1)

    mesh_count = 0
    vertex_count = 0
    polygon_count = 0
    for obj in bpy.data.objects:
        check.require(finite(value for row in obj.matrix_world for value in row), f"{obj.name} has a non-finite world transform")
        check.require(finite(obj.scale), f"{obj.name} has a non-finite scale")
        if obj.type != "MESH":
            continue
        mesh_count += 1
        mesh = obj.data
        mesh.calc_loop_triangles()
        vertex_count += len(mesh.vertices)
        polygon_count += len(mesh.polygons)
        check.require(len(mesh.vertices) >= 3, f"{obj.name} has fewer than three vertices")
        check.require(len(mesh.polygons) >= 1, f"{obj.name} has no visible polygons")
        check.require(all(polygon.area > 1.0e-12 for polygon in mesh.polygons), f"{obj.name} contains zero-area polygons")
        check.require(all(finite(vertex.co) and finite(vertex.normal) for vertex in mesh.vertices), f"{obj.name} has non-finite vertices or normals")
        check.require(all(finite(loop.normal) for loop in mesh.loops), f"{obj.name} has non-finite loop normals")
        check.require(len(mesh.uv_layers) >= 1, f"{obj.name} must provide UV coordinates")
        for uv_layer in mesh.uv_layers:
            check.require(all(finite(loop.uv) for loop in uv_layer.data), f"{obj.name} has non-finite UV coordinates")
        check.require(any(slot.material is not None for slot in obj.material_slots), f"{obj.name} has no material assignment")
        check.require(finite(value for corner in obj.bound_box for value in corner), f"{obj.name} has non-finite bounds")

    for name in REQUIRED_MESH_OBJECTS:
        obj = bpy.data.objects.get(name)
        if obj is not None:
            check.require(obj.type == "MESH", f"{name} must be production mesh geometry")
            if obj.type == "MESH":
                check.require(len(obj.data.vertices) >= 16, f"{name} is too small to be an authored production silhouette")

    if hose_skin is not None and hose_skin.type == "MESH":
        check.require(len(hose_skin.data.vertices) >= 3_000, "corrugated hose must contain a continuous production mesh")
        check.require(len(hose_skin.data.vertices) <= 20_000, "corrugated hose exceeds the performance-conscious vertex budget")
        connected_components = mesh_component_count(hose_skin.data)
        check.require(connected_components == 1, f"corrugated hose must be one connected surface, found {connected_components}")

    check.note(f"scene meshes={mesh_count} vertices={vertex_count} polygons={polygon_count}")
    return {"meshCount": mesh_count, "vertexCount": vertex_count, "polygonCount": polygon_count}


def mesh_component_count(mesh: bpy.types.Mesh) -> int:
    if not mesh.vertices:
        return 0
    adjacency = [set() for _ in mesh.vertices]
    for edge in mesh.edges:
        left, right = edge.vertices
        adjacency[left].add(right)
        adjacency[right].add(left)
    unseen = set(range(len(mesh.vertices)))
    components = 0
    while unseen:
        components += 1
        stack = [unseen.pop()]
        while stack:
            current = stack.pop()
            for neighbor in adjacency[current]:
                if neighbor in unseen:
                    unseen.remove(neighbor)
                    stack.append(neighbor)
    return components


def expected_mesh_binary_layout(vertex_count: int, index_count: int, joint_count: int, corrective_count: int) -> dict[str, int]:
    cursor = MESH_BINARY_HEADER_BYTES
    offsets: dict[str, int] = {}
    for name, byte_count in (
        ("positionsOffset", vertex_count * 12),
        ("normalsOffset", vertex_count * 12),
        ("textureCoordinatesOffset", vertex_count * 8),
        ("jointIndicesOffset", vertex_count * 4),
        ("jointWeightsOffset", vertex_count * 8),
        ("indicesOffset", index_count * 4),
        ("bindMatricesOffset", joint_count * 64),
        ("inverseBindMatricesOffset", joint_count * 64),
        ("correctiveDeltasOffset", corrective_count * vertex_count * 12),
        ("materialOffset", 32),
    ):
        offsets[name] = cursor
        cursor += byte_count
    offsets["payloadOffset"] = MESH_BINARY_HEADER_BYTES
    offsets["payloadByteCount"] = cursor - MESH_BINARY_HEADER_BYTES
    offsets["fileByteCount"] = cursor
    return offsets


def validate_mesh_binary(
    check: Validation,
    path: Path,
    contract_entry: dict[str, object],
    skin: bpy.types.Object,
) -> None:
    check.require(path.is_file(), f"Metal hose mesh binary is missing: {path}")
    if not path.is_file():
        return
    data = path.read_bytes()
    check.require(len(data) >= MESH_BINARY_HEADER_BYTES, "Metal hose mesh binary header is truncated")
    if len(data) < MESH_BINARY_HEADER_BYTES:
        return

    u32 = lambda offset: struct.unpack_from("<I", data, offset)[0]
    check.require(data[:8] == MESH_BINARY_MAGIC, "Metal hose mesh binary magic is invalid")
    check.require(u32(8) == MESH_BINARY_VERSION, "Metal hose mesh binary version is unsupported")
    check.require(u32(12) == MESH_BINARY_ENDIAN_MARKER, "Metal hose mesh binary must explicitly declare little-endian order")
    check.require(u32(16) == MESH_BINARY_HEADER_BYTES, "Metal hose mesh binary header size is invalid")
    check.require(u32(20) == len(data), "Metal hose mesh binary fileByteCount does not match the file")
    vertex_count = u32(24)
    index_count = u32(28)
    joint_count = u32(32)
    corrective_count = u32(36)
    check.require(vertex_count == len(skin.data.vertices), "Metal hose vertexCount does not match VAC_HOSE_SKIN")
    skin.data.calc_loop_triangles()
    check.require(index_count == len(skin.data.loop_triangles) * 3, "Metal hose indexCount does not match triangulated VAC_HOSE_SKIN")
    check.require(joint_count == len(REQUIRED_JOINTS), "Metal hose jointCount must be 64")
    check.require(corrective_count == len(REQUIRED_CORRECTIVE_SHAPES), "Metal hose corrective count must be 2")
    check.require(u32(148) == 4, "Metal hose indices must be UInt32")
    check.require(u32(152) == 2, "Metal hose joint indices must be UInt16")

    expected = expected_mesh_binary_layout(vertex_count, index_count, joint_count, corrective_count)
    header_offsets = {
        "positionsOffset": u32(40),
        "normalsOffset": u32(44),
        "textureCoordinatesOffset": u32(48),
        "jointIndicesOffset": u32(52),
        "jointWeightsOffset": u32(56),
        "indicesOffset": u32(60),
        "bindMatricesOffset": u32(64),
        "inverseBindMatricesOffset": u32(68),
        "correctiveDeltasOffset": u32(72),
        "materialOffset": u32(76),
        "payloadOffset": u32(80),
        "payloadByteCount": u32(84),
        "fileByteCount": u32(20),
    }
    check.require(header_offsets == expected, "Metal hose binary offsets are not the canonical packed schema")
    if header_offsets != expected or expected["fileByteCount"] != len(data):
        return

    payload = data[expected["payloadOffset"] :]
    check.require(hashlib.sha256(payload).digest() == data[112:144], "Metal hose payload SHA-256 is invalid")
    check.require(contract_entry.get("sha256") == sha256(path), "Metal hose contract SHA-256 does not match the binary")
    check.require(contract_entry.get("byteCount") == len(data), "Metal hose contract byteCount does not match the binary")
    check.require(contract_entry.get("vertexCount") == vertex_count, "Metal hose contract vertexCount is invalid")
    check.require(contract_entry.get("indexCount") == index_count, "Metal hose contract indexCount is invalid")
    check.require(contract_entry.get("jointCount") == joint_count, "Metal hose contract jointCount is invalid")

    positions = [Vector(struct.unpack_from("<3f", data, expected["positionsOffset"] + index * 12)) for index in range(vertex_count)]
    normals = [Vector(struct.unpack_from("<3f", data, expected["normalsOffset"] + index * 12)) for index in range(vertex_count)]
    check.require(all(finite(position) for position in positions), "Metal hose positions contain non-finite values")
    check.require(all(finite(normal) and normal.length > 0.5 for normal in normals), "Metal hose normals are invalid")
    check.require(
        all((positions[index] - skin.data.vertices[index].co).length <= 1.0e-6 for index in range(vertex_count)),
        "Metal hose positions do not match the Blender rest mesh",
    )

    indices = struct.unpack_from(f"<{index_count}I", data, expected["indicesOffset"])
    check.require(all(index < vertex_count for index in indices), "Metal hose contains an out-of-range triangle index")
    expected_indices = tuple(vertex for triangle in skin.data.loop_triangles for vertex in triangle.vertices)
    check.require(indices == expected_indices, "Metal hose triangle order does not match deterministic Blender triangulation")

    for vertex_index in range(vertex_count):
        joints = struct.unpack_from("<2H", data, expected["jointIndicesOffset"] + vertex_index * 4)
        weights = struct.unpack_from("<2f", data, expected["jointWeightsOffset"] + vertex_index * 8)
        check.require(all(joint < joint_count for joint in joints), f"Metal hose vertex {vertex_index} has an out-of-range joint")
        check.require(all(math.isfinite(weight) and weight >= 0.0 for weight in weights), f"Metal hose vertex {vertex_index} has invalid weights")
        check.require(math.isclose(sum(weights), 1.0, abs_tol=1.0e-5), f"Metal hose vertex {vertex_index} weights are not normalized")

    for joint_index in range(joint_count):
        bind_values = struct.unpack_from("<16f", data, expected["bindMatricesOffset"] + joint_index * 64)
        inverse_values = struct.unpack_from("<16f", data, expected["inverseBindMatricesOffset"] + joint_index * 64)
        bind = Matrix(tuple(tuple(bind_values[column * 4 + row] for column in range(4)) for row in range(4)))
        inverse = Matrix(tuple(tuple(inverse_values[column * 4 + row] for column in range(4)) for row in range(4)))
        identity_error = max(abs((bind @ inverse)[row][column] - (1.0 if row == column else 0.0)) for row in range(4) for column in range(4))
        check.require(identity_error <= 1.0e-4, f"Metal hose bind/inverse-bind pair {joint_index} is inconsistent")

    shape_keys = skin.data.shape_keys
    basis = shape_keys.key_blocks.get("Basis") if shape_keys is not None else None
    if basis is not None:
        for corrective_index, name in enumerate(REQUIRED_CORRECTIVE_SHAPES):
            shape = shape_keys.key_blocks.get(name)
            if shape is None:
                continue
            section = expected["correctiveDeltasOffset"] + corrective_index * vertex_count * 12
            deltas = [Vector(struct.unpack_from("<3f", data, section + vertex_index * 12)) for vertex_index in range(vertex_count)]
            expected_deltas = [shape.data[index].co - basis.data[index].co for index in range(vertex_count)]
            check.require(
                all((left - right).length <= 1.0e-6 for left, right in zip(deltas, expected_deltas)),
                f"Metal hose corrective {name} does not match its Blender shape key",
            )
            check.require(any(delta.length >= 0.0005 for delta in deltas), f"Metal hose corrective {name} contains no visible deltas")

    bounds_min = tuple(struct.unpack_from("<3f", data, 88))
    bounds_max = tuple(struct.unpack_from("<3f", data, 100))
    actual_min = tuple(min(position[axis] for position in positions) for axis in range(3))
    actual_max = tuple(max(position[axis] for position in positions) for axis in range(3))
    check.require(all(math.isclose(left, right, abs_tol=1.0e-6) for left, right in zip(bounds_min, actual_min)), "Metal hose minimum bounds are invalid")
    check.require(all(math.isclose(left, right, abs_tol=1.0e-6) for left, right in zip(bounds_max, actual_max)), "Metal hose maximum bounds are invalid")
    check.require(
        contract_entry.get("bounds")
        == {
            "min": [round(float(value), 7) for value in actual_min],
            "max": [round(float(value), 7) for value in actual_max],
        },
        "Metal hose contract bounds do not match the binary rest positions",
    )

    material_values = struct.unpack_from("<8f", data, expected["materialOffset"])
    check.require(all(math.isfinite(value) and 0.0 <= value <= 1.0 for value in material_values), "Metal hose PBR material parameters are invalid")


def validate_contract(check: Validation, contract_path: Path, skip_exports: bool) -> None:
    check.require(contract_path.is_file(), f"asset contract is missing: {contract_path}")
    if not contract_path.is_file():
        return
    try:
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        check.errors.append(f"asset contract cannot be decoded: {error}")
        return

    check.require(contract.get("schemaVersion") == EXPECTED_SCHEMA_VERSION, "asset contract schemaVersion must be 2")
    check.require(contract.get("product") == "Voice VAC", "asset contract product must be Voice VAC")
    check.require(contract.get("units") == {"linear": "meter", "metersPerUnit": 1.0}, "asset contract units are invalid")
    check.require(contract.get("axes") == {"forward": "-Z", "up": "Y", "authoringUp": "Z"}, "asset contract axes are invalid")
    check.require(set(contract.get("runtimeNodes", [])) == REQUIRED_OBJECTS, "asset contract runtimeNodes do not match the stable node contract")
    check.require(contract.get("joints") == REQUIRED_JOINTS, "asset contract joint order is invalid")
    check.require(set(contract.get("materials", [])) == REQUIRED_MATERIALS, "asset contract materials do not match the stable material contract")
    check.require(contract.get("buttonTravelMeters") == EXPECTED_BUTTON_TRAVEL_METERS, "button travel must be exactly 9 mm")
    check.require(is_transform(contract.get("nominalDockTransform")), "nominalDockTransform must be a finite TRS transform")
    check.require(is_transform(contract.get("nozzlePivot")), "nozzlePivot must be a finite TRS transform")

    actual_named_poses = collect_named_poses(check)
    delivery = contract.get("runtimePoseDelivery")
    check.require(isinstance(delivery, dict), "runtimePoseDelivery must be an object")
    contract_named_poses: dict[str, object] = {}
    if isinstance(delivery, dict):
        check.require(delivery.get("mode") == "namedTransforms", "runtime pose delivery must use namedTransforms")
        check.require(delivery.get("usdzAnimationTimeSamples") is False, "runtime exports must honestly declare that USDZ has no animation time samples")
        candidate_poses = delivery.get("namedPoses")
        check.require(isinstance(candidate_poses, dict), "runtimePoseDelivery.namedPoses must be an object")
        if isinstance(candidate_poses, dict):
            contract_named_poses = candidate_poses
            check.require(set(candidate_poses) == set(REQUIRED_NAMED_POSES), "named runtime poses do not match the stable pose contract")
            for pose_name, (node_name, action_name, frame) in REQUIRED_NAMED_POSES.items():
                entry = candidate_poses.get(pose_name)
                check.require(isinstance(entry, dict), f"named pose {pose_name} must be an object")
                if not isinstance(entry, dict):
                    continue
                check.require(entry.get("node") == node_name, f"named pose {pose_name} node is invalid")
                check.require(entry.get("action") == action_name, f"named pose {pose_name} action is invalid")
                check.require(entry.get("frame") == frame, f"named pose {pose_name} frame is invalid")
                check.require(is_transform(entry.get("transform")), f"named pose {pose_name} must include a finite transform")
                actual = actual_named_poses.get(pose_name)
                if actual is not None:
                    check.require(
                        transforms_close(entry.get("transform"), actual["transform"]),
                        f"named pose {pose_name} does not match the evaluated Blender action",
                    )

    dock_pose = contract_named_poses.get("nozzleDocked") if isinstance(contract_named_poses, dict) else None
    if isinstance(dock_pose, dict):
        dock_transform = dock_pose.get("transform")
        check.require(transforms_close(contract.get("nominalDockTransform"), dock_transform), "nominalDockTransform must equal the evaluated nozzleDocked pose")
        check.require(transforms_close(contract.get("nozzlePivot"), dock_transform), "nozzlePivot must equal the true dock-rest pivot")

    contract_bounds = contract.get("localBounds")
    check.require(isinstance(contract_bounds, dict), "localBounds must be an object")
    if isinstance(contract_bounds, dict):
        for name in REQUIRED_OBJECTS:
            bounds = contract_bounds.get(name)
            check.require(is_bounds(bounds), f"localBounds[{name}] must contain finite min/max triples")
            obj = bpy.data.objects.get(name)
            if obj is not None:
                check.require(bounds_close(bounds, local_bounds(obj)), f"localBounds[{name}] does not match the rest-pose Blender scene")

    check.require(contract.get("meshStats") == mesh_statistics(), "meshStats must match the current Blender scene")
    check.require(contract.get("materialAssignments") == material_assignments(), "materialAssignments must match the current Blender scene")

    hose_skin = bpy.data.objects.get("VAC_HOSE_SKIN")
    expected_semantic_payload = scene_semantic_payload(actual_named_poses)
    reproducibility = contract.get("reproducibility")
    check.require(isinstance(reproducibility, dict), "reproducibility must describe the semantic build guarantee")
    if isinstance(reproducibility, dict):
        check.require(reproducibility.get("mode") == "semantic-contract-v1", "reproducibility mode must be semantic-contract-v1")
        check.require(
            reproducibility.get("sceneSemanticSHA256") == semantic_sha256(expected_semantic_payload),
            "sceneSemanticSHA256 does not match normalized scene semantics",
        )
        statement = reproducibility.get("statement")
        check.require(
            isinstance(statement, str) and "bytes" in statement.lower() and "not" in statement.lower(),
            "reproducibility statement must explicitly avoid a byte-determinism claim",
        )
    if hose_skin is not None and hose_skin.type == "MESH":
        check.require(contract.get("skinWeights") == skin_weight_summary(hose_skin), "skinWeights summary must match actual normalized vertex weights")
        check.require(
            contract.get("correctiveBlendShapes") == corrective_shape_summary(hose_skin),
            "correctiveBlendShapes must match the measured Blender shape-key deltas",
        )

        hose_runtime = contract.get("hoseRuntime")
        check.require(isinstance(hose_runtime, dict), "hoseRuntime must define the Metal rendering contract")
        if isinstance(hose_runtime, dict):
            check.require(hose_runtime.get("renderer") == "metalSkinning", "hoseRuntime renderer must be metalSkinning")
            check.require(
                hose_runtime.get("surface") == "transparentMTKView",
                "hoseRuntime surface must be a transparent MTKView",
            )
            check.require(
                hose_runtime.get("realityKitSkeletonTokensAreEntities") is False,
                "the contract must explicitly state that USD skeleton tokens are not RealityKit Entity controls",
            )
            binary = hose_runtime.get("binary")
            check.require(isinstance(binary, dict), "hoseRuntime.binary must describe VoiceVACHose.meshbin")
            if isinstance(binary, dict):
                check.require(binary.get("schema") == "VoiceVACHoseMesh", "Metal hose binary schema name is invalid")
                check.require(binary.get("version") == MESH_BINARY_VERSION, "Metal hose binary schema version is invalid")
                check.require(binary.get("endianness") == "little", "Metal hose binary endianness is invalid")
                check.require(binary.get("headerByteCount") == MESH_BINARY_HEADER_BYTES, "Metal hose headerByteCount is invalid")
                check.require(binary.get("positionComponentType") == "float32", "Metal hose position component type is invalid")
                check.require(binary.get("normalComponentType") == "float32", "Metal hose normal component type is invalid")
                check.require(binary.get("textureCoordinateComponentType") == "float32", "Metal hose UV component type is invalid")
                check.require(binary.get("indexComponentType") == "uint32", "Metal hose index component type is invalid")
                check.require(binary.get("jointIndexComponentType") == "uint16", "Metal hose joint-index component type is invalid")
                check.require(binary.get("jointWeightComponentType") == "float32", "Metal hose joint-weight component type is invalid")
                check.require(binary.get("matrixComponentType") == "float32", "Metal hose matrix component type is invalid")
                check.require(binary.get("matrixLayout") == "columnMajor4x4", "Metal hose matrix layout is invalid")
                check.require(binary.get("maxInfluencesPerVertex") == 2, "Metal hose may use at most two joint influences")
                check.require(binary.get("correctiveBlendShapes") == corrective_shape_summary(hose_skin), "Metal runtime corrective metadata must match Blender")
                validate_mesh_binary(check, contract_path.parent / "VoiceVACHose.meshbin", binary, hose_skin)

    source_hashes = contract.get("sourceHashes", {})
    builder_path = Path(__file__).resolve().with_name("build_voice_vac.py")
    blend_path = Path(bpy.data.filepath).resolve()
    if builder_path.is_file():
        check.require(source_hashes.get("build_voice_vac.py") == sha256(builder_path), "builder source hash does not match")
    if blend_path.is_file():
        check.require(source_hashes.get("voice-vac-machine.blend") == sha256(blend_path), "blend source hash does not match")

    if skip_exports:
        return

    exports = contract.get("exports", {})
    for filename, required_names in {
        "VoiceVACDevice.usdz": {
            "VAC_DEVICE_ROOT",
            "VAC_PORT",
            "VAC_NOZZLE",
            "VAC_NOZZLE_TIP",
            "VAC_BUTTON_BASE",
            "VAC_BUTTON_CAP",
        },
        "VoiceVACHose.usdz": {"VAC_HOSE_ROOT", "VAC_HOSE_SKIN", *REQUIRED_JOINTS},
    }.items():
        path = contract_path.parent / filename
        check.require(path.is_file(), f"runtime export is missing: {path}")
        if not path.is_file():
            continue
        check.require(path.stat().st_size > 1_024, f"runtime export is unexpectedly small: {path}")
        check.require(path.read_bytes()[:4] == b"PK\x03\x04", f"runtime export is not a real USDZ package: {path}")
        export_entry = exports.get(filename, {})
        check.require(export_entry.get("sha256") == sha256(path), f"export hash does not match for {filename}")
        check.require(export_entry.get("byteCount") == path.stat().st_size, f"export byteCount does not match for {filename}")
        validate_usdz(check, path, required_names, contract)


def usd_prim_block(text: str, name: str) -> str | None:
    marker = re.search(rf'\bdef\s+(?:Xform|SkelRoot|Skeleton|Mesh)\s+"{re.escape(name)}"', text)
    if marker is None:
        return None
    opening = text.find("{", marker.end())
    if opening < 0:
        return None
    depth = 0
    for index in range(opening, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[marker.start() : index + 1]
    return None


def usd_triplet(block: str, property_name: str) -> tuple[float, float, float] | None:
    match = re.search(rf"{re.escape(property_name)}\s*=\s*\(([^)]+)\)", block)
    if match is None:
        return None
    try:
        values = tuple(float(value.strip()) for value in match.group(1).split(","))
    except ValueError:
        return None
    return values if len(values) == 3 else None


def triplet_close(actual: tuple[float, float, float] | None, expected: tuple[float, float, float], tolerance: float = 1.0e-4) -> bool:
    return actual is not None and all(abs(left - right) <= tolerance for left, right in zip(actual, expected))


def validate_usdz(check: Validation, path: Path, required_names: set[str], contract: dict[str, object]) -> None:
    checker = subprocess.run(
        ["/usr/bin/usdchecker", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    check.require(checker.returncode == 0, f"usdchecker rejected {path.name}: {(checker.stdout + checker.stderr).strip()}")
    cat = subprocess.run(
        ["/usr/bin/usdcat", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    check.require(cat.returncode == 0, f"usdcat could not inspect {path.name}: {cat.stderr.strip()}")
    if cat.returncode == 0:
        usd_text = cat.stdout
        missing = sorted(name for name in required_names if name not in usd_text)
        check.require(not missing, f"{path.name} does not expose stable runtime names: {missing}")
        delivery = contract.get("runtimePoseDelivery")
        if isinstance(delivery, dict) and delivery.get("usdzAnimationTimeSamples") is False:
            check.require("timeSamples" not in usd_text, f"{path.name} contains animation time samples despite the static-rest contract")

        if path.name == "VoiceVACDevice.usdz":
            nozzle_block = usd_prim_block(usd_text, "VAC_NOZZLE")
            button_block = usd_prim_block(usd_text, "VAC_BUTTON_CAP")
            check.require(nozzle_block is not None, "VoiceVACDevice.usdz is missing the nozzle prim block")
            check.require(button_block is not None, "VoiceVACDevice.usdz is missing the button prim block")
            if nozzle_block is not None:
                check.require(
                    triplet_close(usd_triplet(nozzle_block, "xformOp:translate"), EXPECTED_DOCK_TRANSLATION),
                    "VoiceVACDevice.usdz nozzle is not exported at the dock-rest translation",
                )
                check.require(
                    triplet_close(usd_triplet(nozzle_block, "xformOp:scale"), (1.0, 1.0, 1.0)),
                    "VoiceVACDevice.usdz nozzle is not exported at dock-rest scale",
                )
                check.require(
                    triplet_close(
                        usd_triplet(nozzle_block, "xformOp:rotateXYZ"),
                        (-90.0, 0.0, 90.0),
                        tolerance=1.0e-3,
                    ),
                    "VoiceVACDevice.usdz duckbill does not point upward while docked",
                )
            if button_block is not None:
                check.require(
                    triplet_close(usd_triplet(button_block, "xformOp:translate"), EXPECTED_BUTTON_UP_TRANSLATION),
                    "VoiceVACDevice.usdz button is not exported fully up",
                )
                check.require(
                    triplet_close(usd_triplet(button_block, "xformOp:scale"), (1.0, 1.0, 1.0)),
                    "VoiceVACDevice.usdz button is not exported at button-up scale",
                )
        elif path.name == "VoiceVACHose.usdz":
            check.require("SkelBindingAPI" in usd_text, "VoiceVACHose.usdz must preserve its skin binding")
            check.require("primvars:skel:jointIndices" in usd_text, "VoiceVACHose.usdz must export joint indices")
            check.require("primvars:skel:jointWeights" in usd_text, "VoiceVACHose.usdz must export joint weights")
            missing_joints = [name for name in REQUIRED_JOINTS if name not in usd_text]
            check.require(not missing_joints, f"VoiceVACHose.usdz is missing skeleton joints: {missing_joints}")


def is_transform(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    translation = value.get("translation")
    rotation = value.get("rotationQuaternion")
    scale = value.get("scale")
    return (
        isinstance(translation, list)
        and len(translation) == 3
        and finite(translation)
        and isinstance(rotation, list)
        and len(rotation) == 4
        and finite(rotation)
        and isinstance(scale, list)
        and len(scale) == 3
        and finite(scale)
    )


def is_bounds(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    minimum = value.get("min")
    maximum = value.get("max")
    return (
        isinstance(minimum, list)
        and len(minimum) == 3
        and finite(minimum)
        and isinstance(maximum, list)
        and len(maximum) == 3
        and finite(maximum)
        and all(left <= right for left, right in zip(minimum, maximum))
    )


def validate_preview(check: Validation, preview_path: Path) -> None:
    check.require(preview_path.is_file(), f"rendered preview is missing: {preview_path}")
    if not preview_path.is_file():
        return
    image = bpy.data.images.load(str(preview_path), check_existing=False)
    try:
        check.require(tuple(image.size) == EXPECTED_PREVIEW_SIZE, f"preview must be {EXPECTED_PREVIEW_SIZE[0]}x{EXPECTED_PREVIEW_SIZE[1]}")
        pixels = image.pixels[:]
        alphas = pixels[3::4]
        check.require(bool(alphas), "preview contains no pixels")
        if alphas:
            check.require(min(alphas) < 0.01, "preview must have a transparent background")
            check.require(max(alphas) > 0.95, "preview must contain opaque rendered geometry")
        visible_rgb = [
            max(pixels[index], pixels[index + 1], pixels[index + 2])
            for index in range(0, len(pixels), 4)
            if pixels[index + 3] > 0.1
        ]
        check.require(len(visible_rgb) > 10_000, "preview has too little visible rendered content")
        if visible_rgb:
            check.require(max(visible_rgb) - min(visible_rgb) > 0.25, "preview lacks usable material/color contrast")
    finally:
        bpy.data.images.remove(image)


def main() -> int:
    args = parse_args()
    blend_path = Path(bpy.data.filepath).resolve() if bpy.data.filepath else Path.cwd() / "voice-vac-machine.blend"
    contract_path = (args.contract or blend_path.parent / "asset-contract.json").resolve()

    check = Validation()
    stats = validate_scene(check)
    validate_contract(check, contract_path, args.skip_exports)
    if args.preview:
        validate_preview(check, args.preview.resolve())

    for note in check.notes:
        print(f"NOTE: {note}")
    if check.errors:
        print("Voice VAC asset validation FAILED", file=sys.stderr)
        for error in check.errors:
            print(f" - {error}", file=sys.stderr)
        return 1

    print(
        "Voice VAC asset valid: "
        f"{stats['meshCount']} meshes, {stats['vertexCount']} vertices, "
        f"{stats['polygonCount']} polygons, 64 ordered joints"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
