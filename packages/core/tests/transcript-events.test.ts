import { describe, expect, it } from 'vitest';

import {
  TranscriptEventStream,
  type TranscriptStreamSnapshot
} from '../src/transcript-events.js';

function snapshot(
  revision: number,
  rawSegments: TranscriptStreamSnapshot['rawSegments'] = []
): TranscriptStreamSnapshot {
  return {
    sessionId: 'session_1',
    revision,
    status: 'capturing',
    rawSegments
  };
}

describe('TranscriptEventStream', () => {
  it('falls back to a coherent snapshot when the bounded journal no longer covers the cursor', () => {
    const stream = new TranscriptEventStream({ maximumJournalEntries: 1 });
    const first = { startMs: 0, endMs: 1_000, text: 'one' };
    const second = { startMs: 1_000, endMs: 2_000, text: 'two' };
    const third = { startMs: 2_000, endMs: 3_000, text: 'three' };
    stream.seed(snapshot(0));
    stream.publish(snapshot(1, [first]), [first]);
    stream.publish(snapshot(2, [first, second]), [second]);
    stream.publish(snapshot(3, [first, second, third]), [third]);

    expect(stream.changesSince('session_1', 0)).toEqual({
      sessionId: 'session_1',
      afterRevision: 0,
      revision: 3,
      status: 'capturing',
      appendedSegments: [first, second, third]
    });
    expect(stream.changesSince('session_1', 1)).toMatchObject({
      appendedSegments: [second, third]
    });
  });

  it('registers a waiter synchronously so an immediate publish cannot be missed', async () => {
    const stream = new TranscriptEventStream();
    const segment = { startMs: 0, endMs: 1_000, text: 'arrived' };
    stream.seed(snapshot(0));

    const waiting = stream.waitForChange('session_1', 0, { waitMs: 1_000 });
    stream.publish(snapshot(1, [segment]), [segment]);

    await expect(waiting).resolves.toMatchObject({
      revision: 1,
      appendedSegments: [segment]
    });
  });

  it('rejects an aborted wait and reserves undefined for the long-poll ceiling', async () => {
    const stream = new TranscriptEventStream();
    stream.seed(snapshot(0));
    const controller = new AbortController();
    const aborted = stream.waitForChange('session_1', 0, {
      signal: controller.signal,
      waitMs: 1_000
    });

    controller.abort();

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    await expect(stream.waitForChange('session_1', 0, { waitMs: 5 })).resolves.toBeUndefined();
  });
});
