# Voice Vac PVTT MCP evidence

Status: automated contract verification complete; browser/manual capture is still user-environment dependent.

The test `apps/mcp/tests/mcp-server.test.ts` registers `transcribe_active_video`, calls it with the PVTT schema, and verifies a structured result containing `source_url`, `title`, `language`, `processing_mode`, `transcript`, and ordered segments. It also verifies that a missing browser session returns `isError: true` with `PVTT_NO_ACTIVE_VIDEO` rather than an empty string.

Run:

```bash
npx vitest run apps/mcp/tests/mcp-server.test.ts
```

The MCP client talks only to the authenticated `127.0.0.1` loopback bridge. It does not upload browser audio or use the clipboard as the tool result.
