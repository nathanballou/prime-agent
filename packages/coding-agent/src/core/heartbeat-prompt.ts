/** Imperatives that tell a heartbeat's recipient to advance work rather than describe it. */
const CONTINUATION_VERBS = [
	"continue",
	"resume",
	"proceed",
	"keep going",
	"keep working",
	"pick up",
	"implement",
	"carry on",
	"finish",
	"work on",
	"advance",
] as const;

/**
 * Warn when a heartbeat prompt asks only for status.
 *
 * A heartbeat exists to keep an unattended agent working. A prompt that only requests a report gets
 * exactly that: the agent reports and stops, indefinitely, while looking healthy from outside. On a
 * real overnight run this cost about ninety minutes before the operator noticed the prompt was the
 * cause rather than the model.
 *
 * Only the opening sentence is examined, because that is where the lesson actually lives: a heartbeat
 * that works leads with the work to advance and puts the status request after it. Scanning the whole
 * prompt cannot distinguish an imperative from a question about the same verb — "what advanced since
 * the last check" is a status request that contains "advance".
 *
 * Warns rather than rejects: a status-only heartbeat is a legitimate thing to want, it just should not
 * be an accident.
 *
 * Args:
 * prompt: The heartbeat prompt as configured.
 * Return: A warning to surface, or undefined when the prompt opens by telling the agent to continue.
 */
export function heartbeatPromptWarning(prompt: string): string | undefined {
	const opening = prompt.toLowerCase().split(/[.!?\n]/u, 2)[0] ?? "";
	if (CONTINUATION_VERBS.some((verb) => opening.includes(verb))) return undefined;
	return (
		"This heartbeat prompt does not open by telling the agent to continue, so it will report and " +
		'then stop. Lead with the work to advance (for example "Continue: pick up the next unfinished ' +
		'task and implement it") and put the status request after it.'
	);
}
