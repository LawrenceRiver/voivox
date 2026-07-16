# VOIVOX desktop UI direction

## Grounding

**Subject:** a local, silent audio-to-text workstation for people extracting knowledge from video and live app audio.

**Audience:** a user who wants to start or check a capture in under two seconds, then hand clean raw text to Codex or another language model.

**Single job:** make it immediately obvious which source is being listened to, whether it is truly recording, and where the resulting immutable transcript lives.

## Design pass 1

### Tokens

| Role | Name | Value |
| --- | --- | --- |
| Canvas | Paper noise | `#F3F4F0` |
| Primary text | Graphite | `#162126` |
| Primary action | Tide | `#0B6B6B` |
| Active capture | Amber lamp | `#C77A18` |
| Hairline | Mineral | `#C9CFCA` |
| Critical state | Signal red | `#B94040` |

- Display: `SF Pro Display`, `-apple-system`, `BlinkMacSystemFont`, sans-serif.
- Body: `SF Pro Text`, `-apple-system`, `BlinkMacSystemFont`, sans-serif.
- Time and diagnostics: `SF Mono`, `ui-monospace`, monospace.

### Layout

```
┌─ brand / connection ───────────────────────────────────────────────┐
│  VOIVOX                               [audio engine ● ready]       │
├─ source rail ───────────┬─ capture workspace ──────────────────────┤
│  Chrome tab             │  selected source                         │
│  macOS app              │  [ start silent capture ]                │
│  Microphone             │  time ruler ┃ transcript                 │
│                          │  00:00 ┃ waiting for your first segment  │
├─────────────────────────┴─ recent sessions / Codex availability ───┤
└────────────────────────────────────────────────────────────────────┘
```

### Signature

The transcript is tied to one slender, vertical time ruler. It starts blank, gains a precise amber marker while capture is active, and turns graphite when a session completes. This expresses the product’s actual promise—audio becoming inspectable, timestamped text—without decorative waves, gradients, or floating cards.

## Critique and revision

An early “studio desk” idea with large panels and a prominent waveform would make almost any audio product look similar. It was rejected because it makes the visual metaphor more important than the transcript.

The revised layout starts with source clarity and the time ruler. It uses a narrow left rail only because the three capture surfaces are mutually exclusive inputs. It avoids a hero section, large rounded cards, gradients, stock imagery, and the supplied reference’s type, palette, and composition. The one amber recording marker is reserved for a real active state; all normal actions use Tide.

## Interaction states

- **Ready:** explicit selected source, stable engine label, primary action “Start silent capture”.
- **Capturing:** action changes to “Stop capture”; live region announces status; timer and ruler marker advance with the latest segment.
- **Empty:** directs the user to select a source and says no audio is stored unless retention is enabled.
- **Error:** names the failing source or permission and offers the specific next step, never a generic failure toast.
- **Keyboard:** source choices and primary capture action are native buttons; focus rings remain visible; transcript uses semantic headings and a live region only for state changes.
