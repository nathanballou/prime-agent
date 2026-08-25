import { chmod, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AutoResearchHostMeasurement, AutoResearchHostPorts } from "../src/core/autoresearch/engine.js";
import type { AutoResearchDurableRecipe } from "../src/core/autoresearch/runner.js";
import { canonicalJsonBytes, digestObject, type WorkflowArtifactRef } from "../src/core/workflow/contracts.js";
import {
	createDefaultAutoResearchParts,
	type DefaultPrimeWorkflowProviderInput,
} from "../src/core/workflow/default-prime.js";
import { BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST } from "../src/core/workflow/recipes.js";

const WORKFLOW_ID = "workflow-metric-command";
const OBJECTIVE = "measure a candidate with the operator's command";
const ACCEPTANCE_CHECK_IDS = ["acceptance-1"];
const PROTECTED_INVARIANT_IDS = ["invariant-1"];
const CANDIDATE_ID = "candidate-1";
const ATTEMPT_ID = "attempt-1";

const goalBindingDigest = digestObject({
	workflowId: WORKFLOW_ID,
	objective: OBJECTIVE,
	acceptanceCheckIds: ACCEPTANCE_CHECK_IDS,
	protectedInvariantIds: PROTECTED_INVARIANT_IDS,
});

const resultRef: WorkflowArtifactRef = {
	artifactId: "candidate-result",
	relativePath: "evidence/candidate-result",
	digest: "candidate-result-digest",
	sizeBytes: 1,
	sourceEventSequence: 1,
};

/** The candidate result the real host verifies before it measures anything. */
const resultBytes = canonicalJsonBytes({
	kind: "default-prime-autoresearch-candidate-result",
	workflowId: WORKFLOW_ID,
	objective: OBJECTIVE,
	acceptanceCheckIds: ACCEPTANCE_CHECK_IDS,
	protectedInvariantIds: PROTECTED_INVARIANT_IDS,
	goalBindingDigest,
	candidateId: CANDIDATE_ID,
	attemptId: ATTEMPT_ID,
	candidateRecipeId: BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST.recipeId,
	candidateStageIds: BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST.stages.map((stage) => stage.id),
	baselineUncoveredAdversarialStageCount: 1,
	candidateUncoveredAdversarialStageCount: 0,
});

const recipe = {
	recipeDigest: digestObject({ kind: "metric-command-test-recipe" }),
	registration: {
		runId: "run-metric-command",
		workflowId: WORKFLOW_ID,
		metric: { metricId: "metric-1", name: "score", direction: "lower", target: 0, tolerance: 0 },
		evaluator: { evaluatorDigest: "evaluator", parserDigest: "parser", commandDigest: "command" },
		commandInputBinding: {
			commandDigest: "command",
			inputDigests: ["eval-input", "train-input"],
			bindingDigest: digestObject({ commandDigest: "command", inputDigests: ["eval-input", "train-input"] }),
		},
		seed: { seedId: "seed-1", seedDigest: "seed" },
		guard: { guardDigest: "guard" },
		fixtures: [
			{ fixtureId: "train", partition: "train", inputDigest: "train-input", manifestDigest: "train-manifest" },
			{ fixtureId: "eval", partition: "eval", inputDigest: "eval-input", manifestDigest: "eval-manifest" },
		],
	},
	candidates: [],
} as unknown as AutoResearchDurableRecipe;

/**
 * Build the real default-Prime AutoResearch host over stub authority.
 *
 * Only the seams `measureObservation` actually reads are stubbed: the status reader it binds the goal
 * from, and the artifact resolver it verifies the candidate result through. The metric command itself
 * is executed for real.
 *
 * Args:
 * metricCommand: The operator's configured command, or undefined to leave the host unconfigured.
 * Return: The host ports exposing measureObservation.
 */
async function hostWith(
	metricCommand?: {
		command: string;
		args: readonly string[];
		timeoutMs: number;
	},
	sessionCwd: string = process.cwd(),
): Promise<AutoResearchHostPorts> {
	const input = {
		runtimeStore: { identity: { workflowId: WORKFLOW_ID }, durableContext: {} },
		artifactResolver: {
			resolve: async (ref: WorkflowArtifactRef) => ({
				exists: true as const,
				envelope: { ref, payloadKind: "evidence", codec: "canonical_json", immutable: true as const },
				bytes: resultBytes,
				verifiedDigest: ref.digest,
				verifiedSizeBytes: resultBytes.byteLength,
			}),
		},
		workflowId: WORKFLOW_ID,
		writerIdentity: "metric-command-test",
		epochRef: { storeEpoch: 1 },
		receiptContext: {},
		resolveLeaseRef: async () => ({ storeEpoch: 1, writerIdentity: "metric-command-test" }),
		readStatus: () => ({
			workflowId: WORKFLOW_ID,
			status: "active",
			goal: { objective: OBJECTIVE },
			acceptanceCheckIds: ACCEPTANCE_CHECK_IDS,
			protectedInvariantIds: PROTECTED_INVARIANT_IDS,
		}),
		metricCommand,
		sessionCwd,
	} as unknown as DefaultPrimeWorkflowProviderInput;
	return (await createDefaultAutoResearchParts(input, recipe)).host;
}

/**
 * Measure one verified candidate observation through the real host.
 *
 * Args:
 * script: Absolute path of the metric command, or undefined to leave the host unconfigured.
 * timeoutMs: Timeout the operator configured for the command.
 * Return: The host measurement, crashed or complete.
 */
async function measure(
	script?: string,
	timeoutMs = 30_000,
	sessionCwd: string = process.cwd(),
): Promise<AutoResearchHostMeasurement> {
	const host = await hostWith(script === undefined ? undefined : { command: script, args: [], timeoutMs }, sessionCwd);
	return host.measureObservation({
		observationId: "observation-1",
		candidateId: CANDIDATE_ID,
		attemptId: ATTEMPT_ID,
		rawResultRefs: [resultRef],
	});
}

/**
 * Write an executable script into a fresh temp directory.
 *
 * Args:
 * body: Shell body placed under a `/bin/sh` shebang.
 * Return: Absolute path of the executable script.
 */
async function executableScript(body: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "metric-command-host-"));
	const path = join(dir, "measure.sh");
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
	return path;
}

/**
 * The host has to produce the metric by running the operator's command. The measurement this replaces
 * reported metricValue 0 against baseline 1 with cost and latency derived from artifact byte length
 * while nothing ran an evaluator, so these tests use real executable scripts: a mock would prove the
 * wiring and not the execution.
 */
describe("default Prime autoresearch host measurement", () => {
	it("runs the configured command and reads the measurement out of its stdout", async () => {
		const dir = await mkdtemp(join(tmpdir(), "metric-command-host-"));
		const marker = join(dir, "ran");
		const script = join(dir, "measure.sh");
		await writeFile(
			script,
			`#!/bin/sh\ntouch ${marker}\necho "evaluating 3 fixtures"\necho '{"metricValue":0.25,"baselineMetricValue":0.75,"sampleCount":4,"variance":0.01}'\n`,
		);
		await chmod(script, 0o755);

		const measurement = await measure(script);

		// The marker file only exists if execFile really spawned the script.
		expect((await stat(marker)).isFile()).toBe(true);
		expect(measurement.status).toBe("complete");
		expect(measurement.metricValue).toBe(0.25);
		expect(measurement.baselineMetricValue).toBe(0.75);
		// Four samples come from the command, not from the one raw result ref the observation carries.
		expect(measurement.sampleCount).toBe(4);
		expect(measurement.variance).toBe(0.01);
		expect(measurement.proxySignals).toEqual([]);
		expect(measurement.latencyMilliseconds).toBeGreaterThan(0);
	});

	it("crashes with the failure recorded when the command exits non-zero", async () => {
		const script = await executableScript('echo "evaluator missing" >&2\nexit 3');

		const measurement = await measure(script);

		expect(measurement.status).toBe("crashed");
		expect(measurement.proxySignals).toHaveLength(1);
		expect(measurement.proxySignals[0]).toMatch(/^workflow_metric_command_failed:/);
		expect(measurement.metricValue).toBe(0);
		expect(measurement.baselineMetricValue).toBe(0);
	});

	it("crashes with the failure recorded when the command floods stdout past the buffer cap", async () => {
		// The host caps the command's stdout at 8MB. A runaway evaluator that prints a per-sample log
		// reaches that, and the interesting question is whether the operator gets a legible reason or a
		// measurement that merely looks empty. Nothing covered this, so it stays covered.
		const script = await executableScript("yes 0123456789012345678901234567890123456789 | head -c 9000000");

		const measurement = await measure(script);

		expect(measurement.status).toBe("crashed");
		expect(measurement.proxySignals).toHaveLength(1);
		expect(measurement.proxySignals[0]).toMatch(/^workflow_metric_command_failed:/);
		expect(measurement.proxySignals[0]).toContain("maxBuffer");
		// A crashed measurement must not read as a real one: no metric, no fabricated sample count.
		expect(measurement.metricValue).toBe(0);
		expect(measurement.baselineMetricValue).toBe(0);
	});

	it("crashes with an invalid-output reason when stdout carries no measurement", async () => {
		const script = await executableScript('echo "all good, nothing to report"');

		const measurement = await measure(script);

		expect(measurement.status).toBe("crashed");
		expect(measurement.proxySignals).toEqual(["workflow_metric_command_invalid:stdout is not canonical JSON"]);
	});

	it("crashes with the invalid reason when the command reports a zero sample count", async () => {
		const script = await executableScript(
			`echo '{"metricValue":1,"baselineMetricValue":2,"sampleCount":0,"variance":0}'`,
		);

		const measurement = await measure(script);

		expect(measurement.status).toBe("crashed");
		expect(measurement.proxySignals).toEqual([
			"workflow_metric_command_invalid:sampleCount must be a positive integer",
		]);
	});

	it("crashes as unconfigured rather than inventing a metric when no command is set", async () => {
		const measurement = await measure(undefined);

		expect(measurement.status).toBe("crashed");
		expect(measurement.proxySignals).toEqual(["workflow_metric_command_unconfigured"]);
		expect(measurement.metricValue).toBe(0);
		expect(measurement.latencyMilliseconds).toBe(0);
	});

	it("crashes when the command outlives the configured timeout", async () => {
		const script = await executableScript(
			`sleep 30\necho '{"metricValue":1,"baselineMetricValue":2,"sampleCount":1,"variance":0}'`,
		);

		const measurement = await measure(script, 50);

		expect(measurement.status).toBe("crashed");
		expect(measurement.proxySignals[0]).toMatch(/^workflow_metric_command_failed:/);
	});

	it("runs the command in the session's working directory, where scope checks ask git", async () => {
		const dir = await mkdtemp(join(tmpdir(), "metric-command-host-"));
		const marker = join(dir, "cwd");
		const script = join(dir, "measure.sh");
		await writeFile(
			script,
			`#!/bin/sh\npwd -P > ${marker}\necho '{"metricValue":1,"baselineMetricValue":2,"sampleCount":1,"variance":0}'\n`,
		);
		await chmod(script, 0o755);

		const measurement = await measure(script, 30_000, dir);

		expect(measurement.status).toBe("complete");
		expect((await readFile(marker, "utf8")).trim()).toBe(await realpath(dir));
	});

	it("runs the command in the session directory even when the process sits elsewhere", async () => {
		// A resumed session takes its directory from its own recorded header while the worker process
		// stays where the daemon was started. Before the session cwd was threaded through, the command
		// ran at process.cwd() and could score a different repository than the session was editing —
		// succeeding, and journalling that number as candidate evidence.
		const sessionDir = await realpath(await mkdtemp(join(tmpdir(), "metric-command-session-")));
		const scriptDir = await mkdtemp(join(tmpdir(), "metric-command-script-"));
		const marker = join(scriptDir, "cwd");
		const script = join(scriptDir, "measure.sh");
		await writeFile(
			script,
			`#!/bin/sh\npwd -P > ${marker}\necho '{"metricValue":1,"baselineMetricValue":2,"sampleCount":1,"variance":0}'\n`,
		);
		await chmod(script, 0o755);

		const measurement = await measure(script, 30_000, sessionDir);

		expect(measurement.status).toBe("complete");
		const observed = (await readFile(marker, "utf8")).trim();
		expect(observed).toBe(sessionDir);
		expect(observed).not.toBe(await realpath(process.cwd()));
	});

	it("refuses to measure a candidate result the host cannot verify", async () => {
		const host = await hostWith();
		await expect(
			host.measureObservation({
				observationId: "observation-1",
				candidateId: "someone-elses-candidate",
				attemptId: ATTEMPT_ID,
				rawResultRefs: [resultRef],
			}),
		).rejects.toThrow("default_prime_autoresearch_result_invalid");
	});
});
