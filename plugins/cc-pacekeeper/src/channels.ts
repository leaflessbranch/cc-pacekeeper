import type { Config } from './config';

/**
 * Away-notification directives.
 *
 * The plugin is deliberately channel-agnostic. It never names Signal, Telegram
 * or anything else, and it never sends a message itself — a hook is a
 * short-lived bun process with no MCP access. Instead it emits an instruction,
 * and Claude resolves it against whatever channel tools are actually loaded in
 * that session. Users have different channels; the plugin cannot know which,
 * and hardcoding any would break for everyone else.
 *
 * `preferred` and `target` are opaque strings from the user's own config. This
 * module passes them through verbatim and never parses them.
 */

/**
 * Asked once per session when no channel preference is recorded, so the user
 * can pick from the channels Claude can actually see. Returns null once the
 * user has answered — the flag, not a debounce, is what stops the nagging.
 *
 * Injected at SessionStart rather than Stop: Stop fires at every turn end, so
 * an onboarding prompt there would repeat all session.
 */
export function onboardingDirective(cfg: Config): string | null {
    if (cfg.channels.asked || cfg.channels.preferred.length > 0) return null;
    return [
        '[pacekeeper] No away-channel is configured. Ask the user — once, this session '
            + 'only — how they want to be reached when they step away mid-run.',
        'Offer the channels you can actually see as loaded MCP tools in this session '
            + '(look for message/reply-style tools). If you cannot see any, say so and '
            + 'skip; do not invent options.',
        'On an answer, write it to the `channels` block of '
            + '~/.config/cc-pacekeeper/config.json: `preferred` (their labels, '
            + 'most-preferred first), `target` (the destination id they give you), and '
            + 'set `asked` to true. If they decline, set `asked` to true and leave the '
            + 'rest empty so this is not asked again.'
    ].join(' ');
}

export type AwayNotice = {
    /** Why the user is being disturbed. One short clause. */
    reason: string;
};

/**
 * The directive emitted when the user is away and something worth reporting
 * has happened. Returns null when there is no configured channel, or nothing
 * worth saying.
 *
 * Notifications are for events the user would want to be interrupted for. An
 * "you left" ping with nothing to report is noise, so callers gate on pending
 * work before calling this.
 */
export function awayDirective(cfg: Config, notices: AwayNotice[]): string | null {
    if (notices.length === 0) return null;
    if (cfg.channels.preferred.length === 0) return null;

    const channels = cfg.channels.preferred.join(' or ');
    const target = cfg.channels.target ? ` (target: ${cfg.channels.target})` : '';
    const items = notices.map(n => `- ${n.reason}`).join('\n');

    return [
        `[pacekeeper] The user is away. Send them ONE message via ${channels}${target}, `
            + 'using whichever loaded MCP channel tool matches; that tool may need a '
            + 'ToolSearch first. If no such tool is available, say so here and do not retry.',
        'Report:',
        items,
        'Keep it to a few lines. Batch everything above into a single message — each '
            + 'notification costs a turn, and this plugin exists to conserve quota.'
    ].join('\n');
}

/**
 * Standing away-routing directive: when the user has stepped away, tell Claude
 * to route substantive replies to the preferred channel — for this reply AND
 * every subsequent reply until the user is detected back. This is a STANDING
 * instruction, not a one-turn action, which is why the caller injects it only
 * once per away episode: it persists across turns so Claude doesn't fall back
 * to "go quiet" on turn 2+ merely because no fresh directive arrived.
 *
 * Distinct from awayDirective (which reports specific escalation items and asks
 * for a single wake message). This one carries no report — it establishes where
 * output should go, and lets Claude judge per-turn whether a reply is worth
 * sending. Returns null when no channel is configured.
 */
export function awayRoutingDirective(cfg: Config): string | null {
    if (cfg.channels.preferred.length === 0) return null;

    const channels = cfg.channels.preferred.join(' or ');
    const target = cfg.channels.target ? ` (target: ${cfg.channels.target})` : '';

    return [
        '[pacekeeper] The user has stepped away. Until they are detected back — for '
            + 'this reply and every subsequent reply while they remain away — if the '
            + `reply is substantive (not a trivial acknowledgement) send it to them via ${channels}${target}, `
            + 'using whichever loaded MCP channel tool matches; that tool may need a '
            + 'ToolSearch first. If there is nothing worth interrupting them for, stay quiet.',
        'This instruction stays in effect across turns until the user returns — you '
            + 'will not be reminded each turn. If no matching channel tool is loaded, say '
            + 'so once and do not retry.'
    ].join(' ');
}
