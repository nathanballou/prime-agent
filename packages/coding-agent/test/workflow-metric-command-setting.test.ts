import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

async function managerWith(settings: Record<string, unknown>): Promise<SettingsManager> {
	const dir = await mkdtemp(join(tmpdir(), "metric-command-"));
	const projectDir = join(dir, ".prime", "agent");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(projectDir, "settings.json"), JSON.stringify(settings));
	return SettingsManager.create(dir, join(dir, "global-agent"));
}

/**
 * The host must produce the metric itself. A number reported by the worker being judged is not
 * evidence, so an absent or unusable setting has to leave the measurement refusing rather than
 * guessing at a default command.
 */
describe("workflowMetricCommand setting", () => {
	it("is undefined when unset, so the host keeps refusing to invent a metric", async () => {
		expect((await managerWith({})).getWorkflowMetricCommand()).toBeUndefined();
	});

	it("returns the configured command with a default timeout", async () => {
		const manager = await managerWith({ workflowMetricCommand: { command: "python", args: ["-m", "eval"] } });
		expect(manager.getWorkflowMetricCommand()).toEqual({
			command: "python",
			args: ["-m", "eval"],
			timeoutMs: 600_000,
		});
	});

	it("defaults args to empty rather than requiring the operator to write them", async () => {
		const manager = await managerWith({ workflowMetricCommand: { command: "./evaluate.sh" } });
		expect(manager.getWorkflowMetricCommand()?.args).toEqual([]);
	});

	it("rejects a blank command rather than running an empty string", async () => {
		expect(
			(await managerWith({ workflowMetricCommand: { command: "  " } })).getWorkflowMetricCommand(),
		).toBeUndefined();
	});

	it("clamps a non-positive timeout to the default", async () => {
		const manager = await managerWith({ workflowMetricCommand: { command: "x", timeoutMs: 0 } });
		expect(manager.getWorkflowMetricCommand()?.timeoutMs).toBe(600_000);
	});
});
