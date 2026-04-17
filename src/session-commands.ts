import type { NewMessage } from './types.js';
import { logger } from './logger.js';

/**
 * Matches a slash command: leading `/`, word-character command name, optional
 * `@botname` suffix (Telegram group-chat tap), optional whitespace + args.
 *
 * Capture groups:
 *   1: `/command` (always present)
 *   2: `@botname` (optional, Telegram-only; always stripped before dispatch)
 *   3: arguments (optional, everything after the first whitespace)
 *
 * Covers SDK built-ins (`/compact`, `/clear`, `/cost`, `/model sonnet`,
 * `/resume`, ...), container skills (`/wrap`, `/status`, `/sunsama`, ...),
 * and any future slash command the SDK or a skill adds. The SDK rejects
 * unknown commands on its side — no allowlist upkeep needed here.
 *
 * Multi-line input is rejected (args cannot contain newlines) so bare
 * messages that happen to mention a slash earlier in the line go through
 * the normal message path.
 */
const SLASH_COMMAND_PATTERN = /^(\/[a-zA-Z][\w-]*)(@\w+)?(?:\s+([^\n]+?))?$/;

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command + optional args (e.g. '/compact', '/model sonnet')
 * or null if not a session command. The `@botname` suffix that Telegram auto-appends
 * for group-chat command taps is stripped. Command name is lowercased; args are preserved verbatim.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  const match = SLASH_COMMAND_PATTERN.exec(text);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const args = match[3]?.trim();
  return args ? `${command} ${args}` : command;
}

/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), or trusted/admin sender (is_from_me) in any group.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
): boolean {
  return isMainGroup || isFromMe;
}

/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  // Truthy check (not `=== true`): messages delivered fresh from the channel
  // have `is_from_me: boolean`, but messages round-tripped through the SQLite
  // `messages` table come back as `1`/`0` numbers — and `1 === true` is false
  // in JavaScript. Use `!!` so both shapes work.
  if (!isSessionCommandAllowed(isMainGroup, !!cmdMsg.is_from_me)) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // AUTHORIZED: flush any messages received BEFORE the command in the same
  // batch into the session first — otherwise they'd be lost when the
  // command (e.g. /compact, /clear) mutates session state. Then run the
  // command itself.
  logger.info({ group: groupName, command }, 'Session command');

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCommandMsgs = missedMessages.slice(0, cmdIndex);

  if (preCommandMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCommandMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName, command },
        'Pre-command message flush failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past flushed messages, leave command pending.
        deps.advanceCursor(preCommandMsgs[preCommandMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
