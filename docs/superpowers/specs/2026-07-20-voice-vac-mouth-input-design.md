# Voice VAC Mouth-Embedded URL Interaction Design

## Confirmed visual contract

Voice VAC remains a 406 × 116 pt floating glass capsule. The docked suction head occupies the left port and points out of the screen toward the user. Its duckbill is vertical in the screen plane. The two eyes are not visible while docked.

Double-clicking the suction head performs one continuous game-prop sequence:

1. The head moves away from the camera into screen depth while rotating from the vertical dock orientation into the horizontal operating orientation.
2. A straight accordion tube extends from the circular capsule port. It must not begin with the soft C/S curve used by manual dragging.
3. The horizontal head and straight tube rise above the capsule.
4. Only after the straight lift is established does the duckbill turn sharply toward the user.
5. The duckbill widens into a 280–320 pt mouth slot. `Paste video link` and the Start control are embedded inside the dark mouth opening. No separate URL bubble or transcript-positioned URL window is visible.

The eyes live on the upper side shell of the three-dimensional head. They become visible only after the head has left the dock. Manual drag continues to use the flexible physical hose and does not use the straight URL-input pose.

## Architecture

`NozzleURLAnimator` owns the deterministic staged pose values: depth retreat, dock-to-horizontal rotation, straight vertical lift, late mouth turn, mouth expansion, and embedded-input reveal. `VoiceVACInteractionRuntime` applies those frames to the RealityKit head and to a URL-specific straight hose presentation.

`NozzleHitPanel` becomes the single presentation and input surface for the suction head. It contains the RealityKit view, interaction hit view, close button, and an embedded AppKit URL field clipped to the mouth opening. The production overlay no longer creates or shows `URLInputPanel`; transcript bubbles remain independent and unchanged.

The Blender asset exposes a named `VAC_NOZZLE_DUCKBILL` transform beneath `VAC_NOZZLE`. Runtime mouth expansion scales this authored subtree without stretching the rear cylinder. Eye meshes are attached to the side shell and are runtime-hidden in the dock pose.

## State and accessibility

The embedded field remains disabled and non-focusable until the final mouth-turn stage. When revealed it becomes the first responder, keeps the accessibility identifier `voice-vac-url-field`, accepts Return, and exposes an accessible Start button. Dismissing or retracting the head clears focus and collapses the mouth.

## Acceptance criteria

- Dock pose maps the mouth normal toward the camera and presents the duckbill vertically.
- Dock pose hides both eye meshes.
- The first animation phase moves into Z depth and rotates toward the horizontal operating pose without lateral screen travel.
- The URL hose centerline is collinear until the final head turn.
- Eyes become visible only after leaving the dock.
- The final mouth faces the camera and expands to at least 280 pt of usable input width.
- No production `URLInputPanel` is created or shown.
- `Paste video link` is a descendant of `NozzleHitPanel` and visually clipped inside the mouth slot.
- Manual drag still produces the flexible C/S hose.

