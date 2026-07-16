# Security policy

## Supported line

The current pre-1.0 branch is supported while it is actively maintained. Distribution builds are macOS arm64 only.

## Reporting a vulnerability

Until the public GitHub repository is created, report security issues privately to the project owner rather than opening a public issue. Include reproduction steps, affected version, and whether the issue can expose recordings, transcripts, local tokens, or capture without a user action.

## Security properties

- The desktop bridge binds to `127.0.0.1` and authenticates requests with a per-launch bearer token.
- The Chrome extension uses a narrower, separately stored bridge token.
- Tokens are written with user-only filesystem permissions and never returned by MCP tools.
- Raw transcripts remain local by default. Any third-party LLM or text API integration must be opt-in and text-only.

Do not attach real recordings, bearer tokens, bridge tokens, or API keys to an issue or pull request.
