import { describe, expect, it } from 'vitest';
import { TurnResultStore } from '../src/services/turn-result-store.js';
import type { TurnResultBinding, TurnResult, TurnDeliveryReceipt } from '../src/services/turn-result.js';

const binding: TurnResultBinding = {
  ref: { botId: 'app_result', sessionId: 'session_result', turnId: 'om_result' },
  source: { kind: 'im', platform: 'lark', chatId: 'oc_result', messageId: 'om_result' },
  workerGeneration: 1,
};
const execution: TurnResult['execution'] = { status: 'completed', completedAt: '2026-10-13T00:00:00Z', durationMs: 1200 };
const output: TurnResult['output'] = { status: 'available', format: 'markdown', content: 'Action\n完整正文与证据 https://example.com/evidence', source: 'transcript' };
const receipt: TurnDeliveryReceipt = {
  channel: 'im', platform: 'lark', chatId: 'oc_result', parentMessageId: 'om_result',
  status: 'delivered', messages: [{ kind: 'primary', messageId: 'om_reply' }, { kind: 'attachment', messageId: 'om_file' }],
};

function complete(store: TurnResultStore, current = binding, content = output.content!) {
  store.begin(current);
  store.recordDelivery(current, { ...output, content }, receipt);
  store.recordTerminal(current, execution);
}

describe('ordinary turn result snapshots', () => {
  it.each(['terminal', 'delivery'])('joins terminal and delivery when %s arrives first', first => {
    const store = new TurnResultStore();
    store.begin(binding);
    if (first === 'terminal') store.recordTerminal(binding, execution);
    else store.recordDelivery(binding, output, receipt);
    expect(store.read(binding.ref)).toEqual({ status: 'not_ready' });
    if (first === 'terminal') store.recordDelivery(binding, output, receipt);
    else store.recordTerminal(binding, execution);
    expect(store.read(binding.ref)).toEqual({
      status: 'ready',
      result: { version: 1, ref: binding.ref, source: binding.source, execution, output, deliveries: [receipt] },
    });
  });

  it('keeps model completion separate from partial or unknown delivery', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordTerminal(binding, execution);
    store.recordDelivery(binding, output, { ...receipt, status: 'partial', messages: [{ kind: 'attachment', messageId: 'om_file' }], reason: 'primary_unknown' });
    const lookup = store.read(binding.ref);
    expect(lookup.status).toBe('ready');
    if (lookup.status !== 'ready') throw new Error('Expected ready snapshot');
    expect(lookup.result.execution.status).toBe('completed');
    expect(lookup.result.deliveries[0]).toEqual({
      ...receipt, status: 'partial', messages: [{ kind: 'attachment', messageId: 'om_file' }], reason: 'primary_unknown',
    });
  });

  it('isolates bot, turn, attempt and worker generation without selecting latest', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordDelivery({ ...binding, workerGeneration: 2 }, output, receipt);
    expect(store.read(binding.ref)).toEqual({ status: 'not_ready' });
    complete(store);
    for (const ref of [
      { ...binding.ref, botId: 'app_other' }, { ...binding.ref, turnId: 'om_other' },
      { ...binding.ref, dispatchAttempt: 0 },
    ]) expect(store.read(ref)).toEqual({ status: 'not_found' });
    complete(store, { ...binding, ref: { ...binding.ref, dispatchAttempt: 1 } }, 'second attempt');
    const first = store.read(binding.ref);
    expect(first.status === 'ready' && first.result.output.content).toBe(output.content);
    const second = store.read({ ...binding.ref, dispatchAttempt: 1 });
    expect(second.status === 'ready' && second.result.output.content).toBe('second attempt');
  });

  it('rejects a conflicting source or terminal rather than replacing authoritative facts', () => {
    const store = new TurnResultStore();
    complete(store);
    store.recordDelivery({ ...binding, source: { ...binding.source, chatId: 'oc_other' } }, { ...output, content: 'wrong' }, receipt);
    store.recordTerminal(binding, { status: 'failed' });
    const lookup = store.read(binding.ref);
    expect(lookup.status === 'ready' && lookup.result.execution.status).toBe('completed');
    expect(lookup.status === 'ready' && lookup.result.output.content).toBe(output.content);
  });

  it('returns a detached snapshot that cannot alter later reads', () => {
    const store = new TurnResultStore();
    complete(store);
    const lookup = store.read(binding.ref);
    if (lookup.status !== 'ready') throw new Error('Expected ready snapshot');
    try { lookup.result.output.content = 'tampered'; } catch {}
    try { lookup.result.deliveries[0].messages.push({ kind: 'primary', messageId: 'om_bad' }); } catch {}
    const reread = store.read(binding.ref);
    expect(reread.status === 'ready' && reread.result.output.content).toBe(output.content);
    expect(reread.status === 'ready' && reread.result.deliveries[0].messages).toHaveLength(2);
  });

  it('does not infer empty output from completion without positive silence evidence', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordTerminal(binding, execution);
    expect(store.read(binding.ref)).toEqual({ status: 'not_ready' });
    const silent = { ...binding, ref: { ...binding.ref, turnId: 'om_silent' } };
    store.begin(silent);
    store.recordTerminal(silent, execution, true);
    const lookup = store.read(silent.ref);
    expect(lookup.status === 'ready' && lookup.result.output).toEqual({ status: 'empty' });
  });

  it('does not expose a partial answer on failed execution', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordDelivery(binding, output, receipt);
    store.recordTerminal(binding, { status: 'failed' });
    const lookup = store.read(binding.ref);
    expect(lookup.status === 'ready' && lookup.result.output).toEqual({ status: 'unavailable', reason: 'execution_failed' });
  });

  it('bounds pending and ready entries by count', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    for (let index = 0; index < 128; index++) complete(store, {
      ...binding, ref: { ...binding.ref, turnId: `om_${index}` },
    });
    expect(store.read(binding.ref)).toEqual({ status: 'not_found' });
    expect(store.read({ ...binding.ref, turnId: 'om_127' }).status).toBe('ready');
  });

  it('bounds cached payload bytes without letting reads extend retention', () => {
    const store = new TurnResultStore();
    for (let index = 0; index < 18; index++) complete(store, {
      ...binding, ref: { ...binding.ref, turnId: `om_large_${index}` },
    }, '字'.repeat(340000));
    expect(store.read({ ...binding.ref, turnId: 'om_large_0' })).toEqual({ status: 'not_found' });
    expect(store.read({ ...binding.ref, turnId: 'om_large_17' }).status).toBe('ready');
  });

  it('releases missing final evidence at the pending deadline and expires ready results', () => {
    let now = 0;
    const store = new TurnResultStore({ now: () => now });
    store.begin(binding);
    store.recordTerminal(binding, execution);
    now = 300000;
    expect(store.read(binding.ref)).toEqual({ status: 'unavailable', reason: 'result_not_settled' });
    expect(store.read(binding.ref)).toEqual({ status: 'not_found' });
    complete(store);
    now += 899999;
    expect(store.read(binding.ref).status).toBe('ready');
    now++;
    expect(store.read(binding.ref)).toEqual({ status: 'not_found' });
  });

  it('keeps receipts without pretending an oversized answer is complete or truncated', () => {
    const store = new TurnResultStore();
    complete(store, binding, '字'.repeat(400000));
    const lookup = store.read(binding.ref);
    expect(lookup.status === 'ready' && lookup.result.output).toEqual({ status: 'unavailable', reason: 'result_too_large' });
    expect(lookup.status === 'ready' && lookup.result.deliveries).toEqual([receipt]);
  });

  it('clears only the disabled bot and does not reconstruct cleared results', () => {
    const store = new TurnResultStore();
    complete(store);
    const other = { ...binding, ref: { ...binding.ref, botId: 'app_other' } };
    complete(store, other);
    store.clearBot(binding.ref.botId);
    expect(store.read(binding.ref)).toEqual({ status: 'not_found' });
    expect(store.read(other.ref).status).toBe('ready');
  });
});
