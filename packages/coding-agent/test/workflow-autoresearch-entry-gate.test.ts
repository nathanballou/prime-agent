import { describe, expect, it } from "vitest";
import { assertWorkflowAutoresearchEntered, type WorkflowKernelHostBindings } from "../src/core/agent-session.js";
import type { WorkflowTaskSpecializationProjection } from "../src/core/workflow/contracts.js";

function specialization(
	taskId: string,
	kind: WorkflowTaskSpecializationProjection["base"]["kind"],
	statusTag: string,
): WorkflowTaskSpecializationProjection {
	return {
		base: {
			kind,
			contractVersion: "1",
			phaseTag: kind === "autoresearch" ? "experiment" : "task_execution",
			statusTag,
			sourceJournalSequence: 1,
			sourceJournalDigest: "a".repeat(64),
			payloadRef: {
				artifactId: `specialization:${taskId}`,
				relativePath: `artifacts/${taskId}`,
				digest: "b".repeat(64),
				sizeBytes: 1,
				sourceEventSequence: 1,
			},
		},
		extension: { taskId },
	};
}

function host(specializations: readonly WorkflowTaskSpecializationProjection[]): WorkflowKernelHostBindings {
	return { primeWorkflow: { taskSpecializations: () => specializations } };
}

describe("autoresearch entry gate", () => {
	it("admits a run once one node has entered autoresearch, and names that node", () => {
		expect(
			assertWorkflowAutoresearchEntered(
				host([
					specialization("recon", "autoresearch", "contract_declared"),
					specialization("lens", "native_methodology", "baseline_missing"),
				]),
			),
		).toBe("recon");
	});

	it("refuses a node that has not entered, even while a sibling has", () => {
		// The whole point of per-node state: a ready sibling must not admit a run for a stage
		// that is still being built.
		expect(() =>
			assertWorkflowAutoresearchEntered(
				host([
					specialization("recon", "autoresearch", "contract_declared"),
					specialization("lens", "native_methodology", "baseline_missing"),
				]),
				"lens",
			),
		).toThrow(/lens has not entered autoresearch: baseline_missing/);
	});

	it("refuses to guess when several nodes qualify", () => {
		expect(() =>
			assertWorkflowAutoresearchEntered(
				host([specialization("recon", "autoresearch", "ready"), specialization("probe", "autoresearch", "ready")]),
			),
		).toThrow(/name one with task_id/);
	});

	it("refuses a node that is not in the graph at all", () => {
		expect(() =>
			assertWorkflowAutoresearchEntered(host([specialization("recon", "autoresearch", "ready")]), "ghost"),
		).toThrow(/ghost is not in this task graph/);
	});

	it("refuses a run while every node is in native methodology and names each blocker", () => {
		expect(() =>
			assertWorkflowAutoresearchEntered(
				host([
					specialization("recon", "native_methodology", "metric_command_unconfigured"),
					specialization("lens", "native_methodology", "contract_unfrozen"),
				]),
			),
		).toThrow(/recon=metric_command_unconfigured, lens=contract_unfrozen/);
	});

	it("refuses a run on a host that models no per-node methodology at all", () => {
		expect(() => assertWorkflowAutoresearchEntered({})).toThrow(/No workflow node has entered autoresearch\./);
	});
});
