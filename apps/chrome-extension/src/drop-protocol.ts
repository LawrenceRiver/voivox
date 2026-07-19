import type { TargetSession } from './target-session.js';

const TOKEN_PATTERN = /^VOICE_VAC_DROP_V1\|([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\|([A-Za-z0-9_-]{43})$/u;

export type ParsedDropToken = Readonly<{
  protocolVersion: 1;
  sessionId: string;
  nonce: string;
}>;

type DropIdentity = Pick<TargetSession, 'id' | 'dropNonce' | 'dropToken'>;

export function formatDropToken(sessionId: string, nonce: string): string {
  const token = `VOICE_VAC_DROP_V1|${sessionId}|${nonce}`;
  if (!TOKEN_PATTERN.test(token)) throw new Error('Invalid Voice VAC drop identity.');
  return token;
}

export function parseDropToken(value: unknown): ParsedDropToken | undefined {
  if (typeof value !== 'string') return undefined;
  const match = TOKEN_PATTERN.exec(value);
  if (!match) return undefined;
  return {
    protocolVersion: 1,
    sessionId: match[1]!,
    nonce: match[2]!
  };
}

export function matchesDropToken(session: DropIdentity, supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const parsed = parseDropToken(supplied);
  const expected = parseDropToken(session.dropToken);
  if (!parsed || !expected) return false;
  if (parsed.sessionId !== session.id || expected.sessionId !== session.id) return false;
  return constantTimeBytesEqual(parsed.nonce, session.dropNonce)
    && constantTimeBytesEqual(expected.nonce, session.dropNonce)
    && constantTimeBytesEqual(supplied, session.dropToken);
}

function constantTimeBytesEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
