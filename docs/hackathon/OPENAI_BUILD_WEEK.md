# OpenAI Build Week submission plan

VOIVOX is a strong fit for **Work & Productivity**: it turns otherwise inaccessible video/app audio into local, reusable text and lets Codex operate on the result through MCP. **Apps for Your Life** is a credible alternative if the submission is framed primarily around individual creators and researchers.

The official deadline is **July 21, 2026 at 5:00 PM Pacific Time**. The [challenge page](https://openai.devpost.com/) and [official rules](https://openai.devpost.com/rules) require a working project built with Codex and GPT-5.6, a public repository or judge-accessible private repository, a public YouTube demo under three minutes, and the `/feedback` Codex Session ID for the primary build thread.

## Submission positioning

**One sentence:** VOIVOX silently captures one user-selected media source, transcribes it with a local open model, and exposes immutable text to Codex without hijacking dictation or uploading audio.

**Why it is different:** the Chrome extension is useful by itself, the desktop App adds a durable local library and selected-App capture, and MCP turns every completed transcript into agent-readable context. All three surfaces share a local-first trust model.

## 2:40 demo storyboard

1. **0:00–0:18 — Problem.** Show a video with no usable subtitles. Explain that microphone loopback is noisy, slow, and interferes with normal work.
2. **0:18–0:48 — Standalone extension.** Open VOIVOX, choose Fast or Quality, click once, and keep the host muted. Stop and show the local transcript plus Copy.
3. **0:48–1:18 — Automatic App connection.** Open the VOIVOX App and repeat a short capture. Show that no address/token pairing is required, tab audio remains browser-local, and only completed text is synchronized.
4. **1:18–1:48 — Codex MCP.** Ask Codex to list VOIVOX sessions, read the newest raw transcript, and produce a clearly labeled derived summary without changing the source text.
5. **1:48–2:15 — Product and privacy.** Show Chinese/English switching, the local model route, the 10-minute limit, and the three-surface overview.
6. **2:15–2:40 — Codex build story.** Show dated commits/tests and explain how Codex implemented the desktop, extension, Swift Native Messaging proof, MCP, bilingual UI, security review, and reproducible local-model verification.

Use only music/video for which the entrant owns or has explicit permission. The official rules prohibit copyrighted music or third-party material in the demo unless authorized.

## Required submission assets

- [ ] Public GitHub repository with MIT license.
- [ ] README with one-command development setup and judge install instructions.
- [ ] Downloadable macOS App candidate and Chrome extension ZIP.
- [ ] At least one clean App screenshot, one extension result screenshot, and the three-surface overview PNG.
- [ ] Public YouTube demo under three minutes with narration covering Codex and GPT-5.6.
- [ ] Devpost title, short tagline, category, description, technologies, repository URL, and video URL.
- [ ] `/feedback` Session ID from the main Codex build task.
- [ ] Clear dated section distinguishing work completed during July 13–21, 2026.
- [ ] Final install-from-artifact test on a clean Chrome profile; ideally also a clean Mac user account.

## Codex collaboration evidence

The README should point judges to dated commits and summarize concrete collaboration rather than merely saying “built with AI.” The evidence in this repository includes:

- architecture split into App, standalone extension, and MCP;
- test-driven audio buffering, model lifecycle, and browser recovery behavior;
- security review and HMAC challenge-response for stale Native Messaging connection files;
- bilingual UX and accessibility decisions;
- automated JS/TypeScript/Swift/build/package verification;
- reproducible real-media local-model evidence, plus the final recorded Chrome tab-capture and MCP retrieval demo.

Before submission, add the final recorded Chrome test details and the `/feedback` Session ID to Devpost, not to source code if it contains private metadata.
