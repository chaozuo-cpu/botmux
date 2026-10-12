import { isDocNativeSession, larkTransportEnabled, type DaemonSession } from './types.js';
import type { WorkerToDaemon } from '../types.js';
import type { TurnResult, TurnResultBinding, TurnDeliveryReceipt } from '../services/turn-result.js';
import { getBot } from '../bot-registry.js';
import { getTurnResultRuntime } from './turn-result-runtime.js';
import { replyCardSandboxBlocked } from './turn-reply-card.js';
import { privateReplyEnabled } from './private-reply.js';
import { isSilentScheduledTurn } from './silent-schedule-turns.js';
import { isSubstituteTurn } from './reply-target.js';
import { TurnReplyCardStore } from '../services/turn-reply-card.js';
import { config } from '../config.js';
import { frozenReplyContextForTurn } from './reply-target.js';

export function turnResultEnabled(botId: string): boolean {
  try { return getBot(botId).config.turnResults?.enabled === true; } catch { return false; }
}

export function turnResultSessionEligible(session: DaemonSession, turnId: string, dispatchAttempt?: number): boolean {
  try {
    return turnResultEnabled(session.larkAppId) && !!turnId
      && larkTransportEnabled({ chatId: session.chatId, apiOnly: getBot(session.larkAppId).config.apiOnly })
      && !isDocNativeSession(session) && !session.docCommentTurns?.has(turnId)
      && !session.session.vcMeetingReceiver && !session.session.deferredScheduleRun
      && !session.session.headless && !session.adoptedFrom && !session.session.adoptedFrom
      && !privateReplyEnabled(session.session) && !replyCardSandboxBlocked(session)
      && !isSilentScheduledTurn(session, turnId) && !isSubstituteTurn(session, turnId)
      && !session.pendingWaitPromises?.has(turnId) && !session.asyncTriggerResults?.has(turnId)
      && !(dispatchAttempt !== undefined && (session.suppressedFinalOutputTurns?.get(turnId) ?? -1) >= dispatchAttempt);
  } catch { return false; }
}

export function turnResultBinding(
  session: DaemonSession, turnId: string, dispatchAttempt?: number,
  workerGeneration = session.session.workerGeneration,
): TurnResultBinding | undefined {
  if (!turnResultSessionEligible(session, turnId, dispatchAttempt)
    || !Number.isSafeInteger(workerGeneration) || (workerGeneration ?? 0) <= 0) return undefined;
  return {
    ref: { botId: session.larkAppId, sessionId: session.session.sessionId, turnId,
      ...(dispatchAttempt === undefined ? {} : { dispatchAttempt }) },
    source: { kind: 'im', platform: 'lark', chatId: session.chatId, messageId: turnId },
    workerGeneration: workerGeneration!,
  };
}

export function observeTurnResultTerminal(
  session: DaemonSession,
  terminal: Extract<WorkerToDaemon, { type: 'turn_terminal' }>,
  workerGeneration: number,
): void {
  const binding = turnResultBinding(session, terminal.turnId, terminal.dispatchAttempt, workerGeneration);
  if (!binding || terminal.sessionId !== session.session.sessionId) return;
  try {
    const runtime = getTurnResultRuntime();
    runtime?.begin(binding);
    if (terminal.status === 'completed') {
      const record = new TurnReplyCardStore(config.session.dataDir).read({
        larkAppId: binding.ref.botId, sessionId: binding.ref.sessionId, turnId: binding.ref.turnId,
        ...(binding.ref.dispatchAttempt === undefined ? {} : { dispatchAttempt: binding.ref.dispatchAttempt }),
      });
      if (record?.finalDelivered && record.finalSource === 'explicit' && record.finalText !== undefined
        && record.messageId && record.chatId === binding.source.chatId) {
        const target = frozenReplyContextForTurn(session, terminal.turnId).target;
        runtime?.delivery(binding, { status: 'available', format: 'markdown', content: record.finalText, source: 'explicit' }, {
          channel: 'im', status: 'delivered', platform: 'lark', chatId: binding.source.chatId,
          ...(target.mode !== 'plain' ? { parentMessageId: target.rootMessageId } : {}),
          messages: [{ kind: 'primary', messageId: record.messageId },
            ...(record.overflowMessageId ? [{ kind: 'attachment' as const, messageId: record.overflowMessageId }] : [])],
        });
      }
    }
    runtime?.terminal(binding, {
      status: terminal.status,
      ...(terminal.completedAtMs !== undefined && Number.isFinite(terminal.completedAtMs) && terminal.completedAtMs > 0
        ? { completedAt: new Date(terminal.completedAtMs).toISOString() } : {}),
      ...(Number.isSafeInteger(terminal.durationMs) && terminal.durationMs! >= 0 ? { durationMs: terminal.durationMs } : {}),
    }, terminal.outputDisposition === 'nothing_to_send');
  } catch {}
}

export function observeTurnResultDelivery(
  binding: TurnResultBinding | undefined, output: TurnResult['output'], receipt: TurnDeliveryReceipt,
): void {
  if (!binding) return;
  try {
    const runtime = getTurnResultRuntime();
    runtime?.begin(binding);
    runtime?.delivery(binding, output, receipt);
  } catch {}
}
