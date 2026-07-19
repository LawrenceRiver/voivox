#!/usr/bin/env python3
"""Build the Voice Vac prototype asset as reproducible Blender/GLB output."""

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


ANIMATION_NAMES = ("idle", "drag", "stretch", "snap", "suction", "complete", "collapse", "error")


def material(name, color, metallic=0.0, roughness=0.35, transmission=0.0, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, alpha)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        if bsdf.inputs.get("Base Color"):
            bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        if bsdf.inputs.get("Metallic"):
            bsdf.inputs["Metallic"].default_value = metallic
        if bsdf.inputs.get("Roughness"):
            bsdf.inputs["Roughness"].default_value = roughness
        if bsdf.inputs.get("Transmission Weight"):
            bsdf.inputs["Transmission Weight"].default_value = transmission
        elif bsdf.inputs.get("Transmission"):
            bsdf.inputs["Transmission"].default_value = transmission
        if bsdf.inputs.get("Alpha"):
            bsdf.inputs["Alpha"].default_value = alpha
        if bsdf.inputs.get("IOR"):
            bsdf.inputs["IOR"].default_value = 1.45
    if alpha < 1.0:
        mat.surface_render_method = "DITHERED"
    return mat


def assign(obj, mat):
    obj.data.materials.append(mat)
    return obj


def rounded_cube(name, location, scale, mat, bevel=0.25):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    modifier = obj.modifiers.new("Soft bevel", "BEVEL")
    modifier.width = bevel
    modifier.segments = 8
    modifier.limit_method = "ANGLE"
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    assign(obj, mat)
    return obj


def cylinder(name, location, radius, depth, mat, rotation=(0.0, 0.0, 0.0), vertices=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    assign(obj, mat)
    bevel = obj.modifiers.new("Edge bevel", "BEVEL")
    bevel.width = min(radius * 0.12, 0.06)
    bevel.segments = 4
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    return obj


def torus(name, location, major, minor, mat, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=64, minor_segments=16, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    assign(obj, mat)
    return obj


def sphere(name, location, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign(obj, mat)
    return obj


def ribbed_hose(name, start, length, radius, mat, ribs=28, sides=24):
    vertices = []
    faces = []
    for i in range(ribs + 1):
        t = i / ribs
        center = Vector((start[0] + 0.55 * math.sin(t * math.pi), start[1], start[2] - length * t))
        tangent = Vector((0.55 * math.pi * math.cos(t * math.pi), 0.0, -length))
        tangent.normalize()
        n1 = tangent.cross(Vector((0.0, 1.0, 0.0))).normalized()
        n2 = tangent.cross(n1).normalized()
        corrugation = radius * (1.0 + 0.13 * math.sin(t * math.pi * 2.0 * ribs))
        for j in range(sides):
            theta = 2.0 * math.pi * j / sides
            offset = n1 * (math.cos(theta) * corrugation) + n2 * (math.sin(theta) * corrugation)
            vertices.append(tuple(center + offset))
    for i in range(ribs):
        for j in range(sides):
            a = i * sides + j
            b = i * sides + (j + 1) % sides
            c = (i + 1) * sides + (j + 1) % sides
            d = (i + 1) * sides + j
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new(f"{name}Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    assign(obj, mat)
    bevel = obj.modifiers.new("Rib softening", "BEVEL")
    bevel.width = radius * 0.08
    bevel.segments = 2
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    return obj


def add_animation(name, target):
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    animation_data = target.animation_data_create()
    animation_data.action = action
    target.rotation_euler[2] = 0.0
    target.keyframe_insert(data_path="rotation_euler", index=2, frame=1.0)
    target.rotation_euler[2] = 0.035 if name in {"drag", "suction"} else 0.0
    target.keyframe_insert(data_path="rotation_euler", index=2, frame=8.0)
    target.rotation_euler[2] = 0.0
    target.keyframe_insert(data_path="rotation_euler", index=2, frame=16.0)
    track = animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, action)
    strip.frame_end = 16.0
    animation_data.action = None
    return action


def build(output_dir):
    os.makedirs(output_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    glass = material("VoiceVacGlass", (0.92, 0.98, 0.98), metallic=0.05, roughness=0.16, transmission=0.22, alpha=0.96)
    pearl = material("NozzlePearl", (0.86, 0.92, 0.92), metallic=0.08, roughness=0.22)
    rubber = material("HoseRubber", (0.12, 0.18, 0.19), metallic=0.0, roughness=0.28)
    dark = material("PortInterior", (0.015, 0.027, 0.03), metallic=0.25, roughness=0.18)
    steel = material("PortSteel", (0.42, 0.56, 0.57), metallic=0.78, roughness=0.2)
    eye = material("NozzleEye", (0.035, 0.08, 0.09), metallic=0.1, roughness=0.2)

    root = bpy.data.objects.new("VoiceVacRoot", None)
    bpy.context.collection.objects.link(root)
    body = rounded_cube("VoiceVacBody", (0.0, 0.0, 0.1), (3.5, 1.05, 0.84), glass, 0.72)
    body.parent = root

    for side, x in (("Left", -3.42), ("Right", 3.42)):
        port = cylinder(f"Port{side}", (x, 0.0, 0.1), 0.57, 0.34, steel, rotation=(0.0, math.pi / 2, 0.0))
        port.parent = root
        disc = cylinder(f"Port{side}Interior", (x + (0.18 if side == "Left" else -0.18), 0.0, 0.1), 0.39, 0.05, dark, rotation=(0.0, math.pi / 2, 0.0))
        disc.parent = root
        ring = torus(f"Port{side}Ring", (x + (0.21 if side == "Left" else -0.21), 0.0, 0.1), 0.48, 0.055, glass, rotation=(0.0, math.pi / 2, 0.0))
        ring.parent = root

    hose = ribbed_hose("HoseMesh", (-3.75, 0.0, 0.1), 3.8, 0.30, rubber, ribs=48)
    hose_root = bpy.data.objects.new("HoseRoot", None)
    hose_root.empty_display_size = 0.2
    bpy.context.collection.objects.link(hose_root)
    hose_root.parent = root
    hose.parent = hose_root
    hose_tip = bpy.data.objects.new("HoseTip", None)
    hose_tip.empty_display_size = 0.16
    hose_tip.location = (-3.75, 0.0, -3.7)
    bpy.context.collection.objects.link(hose_tip)
    hose_tip.parent = hose_root
    for i in range(6):
        sleeve = torus(f"HoseSleeve{i}", (-3.75 + 0.55 * math.sin((i / 5) * math.pi), 0.0, -0.2 - i * 0.68), 0.33, 0.055, steel)
        sleeve.parent = hose_root

    nozzle_root = bpy.data.objects.new("NozzleRoot", None)
    bpy.context.collection.objects.link(nozzle_root)
    nozzle_root.location = (-3.75, 0.0, -4.0)
    nozzle_root.parent = root
    nozzle = rounded_cube("NozzleBody", (0.0, 0.0, -0.05), (0.9, 0.44, 0.32), pearl, 0.22)
    nozzle.parent = nozzle_root
    eye_group = bpy.data.objects.new("NozzleEyes", None)
    bpy.context.collection.objects.link(eye_group)
    eye_group.parent = nozzle_root
    for index, x in enumerate((-0.25, 0.25)):
        eye_outer = sphere(f"NozzleEyeOuter{index}", (x, -0.43, 0.05), (0.13, 0.08, 0.13), glass)
        eye_outer.parent = eye_group
        eye_inner = sphere(f"NozzleEyeInner{index}", (x, -0.49, 0.05), (0.065, 0.04, 0.065), eye)
        eye_inner.parent = eye_group

    for animation in ANIMATION_NAMES:
        add_animation(animation, root)

    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    blend_path = os.path.join(output_dir, "voice-vac-machine.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)

    glb_path = os.path.join(output_dir, "voice-vac-machine.glb")
    bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB", export_apply=True, export_animations=True, export_nla_strips=True)
    print(f"Voice Vac assets written to {output_dir}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)
    build(os.path.abspath(args.output_dir))


if __name__ == "__main__":
    main()
