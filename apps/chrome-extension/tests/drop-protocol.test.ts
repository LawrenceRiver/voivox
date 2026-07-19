import { describe, expect, it } from 'vitest';

import {
  formatDropToken,
  matchesDropToken,
  parseDropToken
} from '../src/drop-protocol.js';

const SESSION_ID = '2b0fe529-4021-4674-b55e-1cf081f947dd';
const OTHER_SESSION_ID = 'b24f9360-9f19-4e1e-8000-5e5f6f98bf77';
const NONCE = `${'AbCdEf0123456789_-'.repeat(2)}AbCdEfg`;
const OTHER_NONCE = `${'ZyXwVu9876543210_-'.repeat(2)}ZyXwVut`;

describe('external drop protocol', () => {
  it('round-trips only the exact version-one plain text token', () => {
    const token = formatDropToken(SESSION_ID, NONCE);

    expect(NONCE).toHaveLength(43);
    expect(parseDropToken(token)).toEqual({
      protocolVersion: 1,
      sessionId: SESSION_ID,
      nonce: NONCE
    });
    expect(parseDropToken(`${token}\n`)).toBeUndefined();
    expect(parseDropToken(` ${token}`)).toBeUndefined();
    expect(parseDropToken(`${token} `)).toBeUndefined();
    expect(parseDropToken(`https://example.com/${token}`)).toBeUndefined();
    expect(parseDropToken('https://example.com')).toBeUndefined();
    expect(parseDropToken('VOICE_VAC_DROP_V2|x|y')).toBeUndefined();
  });

  it.each([
    `VOICE_VAC_DROP_V1|${SESSION_ID}|${NONCE}|extra`,
    `VOICE_VAC_DROP_V1|${SESSION_ID.toUpperCase()}|${NONCE}`,
    `VOICE_VAC_DROP_V1|2b0fe529-4021-1674-b55e-1cf081f947dd|${NONCE}`,
    `VOICE_VAC_DROP_V1|2b0fe529-4021-4f74-755e-1cf081f947dd|${NONCE}`,
    `VOICE_VAC_DROP_V1|${SESSION_ID}|${NONCE.slice(1)}`,
    `VOICE_VAC_DROP_V1|${SESSION_ID}|${NONCE}A`,
    `VOICE_VAC_DROP_V1|${SESSION_ID}|${NONCE.slice(0, 42)}+`,
    `VOICE_VAC_DROP_V1|${SESSION_ID}|${NONCE.slice(0, 42)}/`,
    `VOICE_VAC_DROP_V1|${SESSION_ID}|${NONCE.slice(0, 42)}=`,
    `VOICE_VAC_DROP_V1｜${SESSION_ID}|${NONCE}`,
    `ＶOICE_VAC_DROP_V1|${SESSION_ID}|${NONCE}`
  ])('rejects malformed identity bytes without normalization: %s', (candidate) => {
    expect(parseDropToken(candidate)).toBeUndefined();
  });

  it('rejects invalid formatter inputs rather than producing a near-token', () => {
    expect(() => formatDropToken('not-a-uuid', NONCE)).toThrow('Invalid Voice VAC drop identity.');
    expect(() => formatDropToken(SESSION_ID, NONCE.slice(1))).toThrow('Invalid Voice VAC drop identity.');
    expect(() => formatDropToken(SESSION_ID, `${NONCE.slice(0, 42)}+`)).toThrow('Invalid Voice VAC drop identity.');
  });

  it('matches the supplied token to the stored session id, nonce, and canonical token', () => {
    const session = {
      id: SESSION_ID,
      dropNonce: NONCE,
      dropToken: formatDropToken(SESSION_ID, NONCE)
    };

    expect(matchesDropToken(session, session.dropToken)).toBe(true);
    expect(matchesDropToken(session, formatDropToken(OTHER_SESSION_ID, NONCE))).toBe(false);
    expect(matchesDropToken(session, formatDropToken(SESSION_ID, OTHER_NONCE))).toBe(false);
    expect(matchesDropToken({ ...session, dropNonce: OTHER_NONCE }, session.dropToken)).toBe(false);
    expect(matchesDropToken({
      ...session,
      dropToken: formatDropToken(SESSION_ID, OTHER_NONCE)
    }, session.dropToken)).toBe(false);
    expect(matchesDropToken(session, `${session.dropToken}\n`)).toBe(false);
  });
});
