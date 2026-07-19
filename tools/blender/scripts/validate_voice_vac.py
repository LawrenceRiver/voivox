#!/usr/bin/env python3
import bpy
import sys

EXPECTED_OBJECTS = {"VoiceVacBody", "PortLeft", "PortRight", "HoseRoot", "HoseTip", "NozzleEyes"}
EXPECTED_ANIMATIONS = {"idle", "drag", "stretch", "snap", "suction", "complete", "collapse", "error"}

objects = set(bpy.data.objects.keys())
missing_objects = EXPECTED_OBJECTS - objects
actions = set(bpy.data.actions.keys())
missing_animations = EXPECTED_ANIMATIONS - actions
if missing_objects or missing_animations:
    print(f"Missing objects: {sorted(missing_objects)}")
    print(f"Missing animations: {sorted(missing_animations)}")
    sys.exit(1)
print(f"Voice Vac asset valid: {len(objects)} objects, {len(actions)} actions")
