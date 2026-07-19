import bpy
import math
import os
import sys
from mathutils import Vector

arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
asset_index = arguments.index("--asset") + 1 if "--asset" in arguments else -1
if asset_index > 0 and asset_index < len(arguments):
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(arguments[asset_index]))
output_index = arguments.index("--output") + 1 if "--output" in arguments else -1
output = arguments[output_index] if output_index > 0 and output_index < len(arguments) else os.environ.get("VOICE_VAC_PREVIEW", "/tmp/voice-vac-machine-preview.png")
bpy.ops.object.camera_add(location=(0.0, -19.0, -1.6), rotation=(math.radians(82.0), 0.0, 0.0))
camera = bpy.context.object
camera.data.lens = 48
camera.rotation_euler = (Vector((0.0, 0.0, -1.0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.camera = camera

for location, energy, size in [((-3.0, -7.0, 7.0), 900, 5.0), ((5.0, -5.0, 2.0), 700, 4.0), ((0.0, 4.0, 2.0), 500, 3.0)]:
    bpy.ops.object.light_add(type="AREA", location=location)
    light = bpy.context.object
    light.data.energy = energy
    light.data.shape = "DISK"
    light.data.size = size
    light.rotation_euler = (Vector((0.0, 0.0, -1.0)) - light.location).to_track_quat("-Z", "Y").to_euler()

bpy.context.scene.render.engine = "BLENDER_EEVEE"
bpy.context.scene.render.resolution_x = 1200
bpy.context.scene.render.resolution_y = 720
bpy.context.scene.render.resolution_percentage = 100
bpy.context.scene.render.filepath = output
world = bpy.data.worlds.new("VoiceVacPreviewWorld")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.035, 0.05, 0.055, 1.0)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.22
bpy.context.scene.world = world
bpy.ops.render.render(write_still=True)
print(output)
