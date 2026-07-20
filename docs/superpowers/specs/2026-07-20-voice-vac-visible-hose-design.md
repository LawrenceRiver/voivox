# Voice VAC Visible Hose Design

## Approval

The user approved implementation on 2026-07-20 with “开始做”. This document turns the approved visual rule into an executable contract.

## Product rule

The white corrugated vacuum hose is the product’s main character. It is not hidden implementation plumbing. The glass capsule remains 406 × 116 points and contains the docked rectangular vacuum mouth and red mechanical button. The hose is visibly stored at the nozzle port while idle, then leaves the capsule and can cross the desktop when the mouth is deployed.

## States

| State | Required visible result |
| --- | --- |
| Idle | A short bright-white corrugated segment is visible at the left nozzle port. It has a slightly curled settled profile and cannot be mistaken for an invisible line. |
| Deploying | A hose begins at the capsule port and follows the mouth with a soft sideways C/S-shaped lead-in. Active length increases before the mouth reaches the pointer. |
| Dragging / attached | The hose remains continuously visible from capsule to mouth. It preserves rounded corrugations, small asymmetric bends, and is never replaced by a straight line. |
| Transcribing | The connected hose stays visible and shows restrained warm particle flow from mouth toward capsule. |
| Retraction | The mouth returns to the port while active length monotonically shortens. The final state restores the visible stored segment. |

## Technical design

The existing 64-joint Metal-skinned hose remains the render source for every desktop overlay. `HoseRenderSession` gains two presentation rules: a short multi-joint stowed pose at the port, and a deployed pose with at least 18% slack above endpoint span. `VoiceVACInteractionRuntime` requests visual deployment on mouse-down, before macOS native drag transport can fail. A Chrome target rejection changes the state light but never hides the hose.

## Non-goals

- No ASR, Extension, MCP, or media-source changes.
- No claim of a physically exact elastomer simulation; this is a controllable game-prop approximation.
- No change to the capsule size or private-audio boundaries.

## Acceptance checks

1. Starting the App publishes a non-degenerate multi-joint hose snapshot at the capsule port.
2. Starting a drag publishes a hose with active length at least endpoint span plus 18% slack.
3. A rejected target preserves the deployed hose until the user retracts it or starts another drag.
4. Retraction ends with the same visible stowed pose, not a one-segment or zero-length hose.
5. A native App screenshot visibly shows the stored hose and an intentionally forced deployed pose.
