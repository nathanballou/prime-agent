import { describe, expect, it } from "vitest";
import { heartbeatPromptWarning } from "../src/core/heartbeat-prompt.js";

/**
 * The heartbeat that cost about ninety minutes on a real overnight run asked only for a report, and
 * the agent obliged: it reported and stopped, repeatedly, while `list` showed it idle and healthy.
 * The prompt was the cause, not the model.
 */
describe("heartbeat prompt warning", () => {
	it("warns on the exact status-only prompt that produced report-and-halt", () => {
		const warning = heartbeatPromptWarning(
			"Heartbeat. Report in five lines or fewer: what advanced since the last check, what is " +
				"blocked, your current weekly denominator, the number of weeks with nonzero exposure, and " +
				"anything you changed about a control.",
		);
		expect(warning).toMatch(/continue/);
		expect(warning).toMatch(/report and\s+then stop/);
	});

	it("stays quiet when the prompt leads with the work to advance", () => {
		expect(
			heartbeatPromptWarning(
				"Continue the objective now. Pick up the next unfinished task and implement it, committing " +
					"as you go. Then append at most five lines of status.",
			),
		).toBeUndefined();
	});

	it("accepts any of the continuation verbs, not just the word continue", () => {
		for (const prompt of [
			"Resume where you left off and report briefly.",
			"Keep going until the suite is green.",
			"Proceed with the plan.",
			"Implement the next task.",
			"Finish the remaining work.",
		])
			expect(heartbeatPromptWarning(prompt)).toBeUndefined();
	});

	it("is case-insensitive, so a capitalised imperative is not flagged", () => {
		expect(heartbeatPromptWarning("CONTINUE the objective.")).toBeUndefined();
	});

	it("warns on an empty prompt rather than treating it as fine", () => {
		expect(heartbeatPromptWarning("")).toBeDefined();
	});
});
