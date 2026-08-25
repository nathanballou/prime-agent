import type { WorkflowTaskSpecializationProjection } from "./contracts.js";

/**
 * Pick the node an autoresearch run belongs to.
 *
 * Entry is per-node state: one stage can be in autoresearch while a sibling is still being built.
 * Collapsing that to "some node qualifies" lets a run started against a ready node act for the whole
 * workflow, which is the granularity the projection exists to preserve.
 *
 * Args:
 * specializations: Current per-node methodology projections.
 * requestedTaskId: Node the caller named, or undefined to infer when exactly one qualifies.
 * Return: The task id the run is admitted for.
 */
export function resolveAutoresearchTask(
	specializations: readonly WorkflowTaskSpecializationProjection[],
	requestedTaskId?: string,
): string {
	const entered = specializations.filter((entry) => entry.base.kind === "autoresearch");
	if (requestedTaskId !== undefined) {
		const named = specializations.find((entry) => entry.extension.taskId === requestedTaskId);
		if (named === undefined)
			throw new Error(
				`Workflow node ${requestedTaskId} is not in this task graph${describeNodes(specializations)}.`,
			);
		if (named.base.kind !== "autoresearch")
			throw new Error(
				`Workflow node ${requestedTaskId} has not entered autoresearch: ${named.base.statusTag ?? named.base.phaseTag}. ` +
					"Autoresearch runs on a node whose contract is frozen, whose baseline exists, and whose metric command is configured.",
			);
		return requestedTaskId;
	}
	if (entered.length === 1) return entered[0].extension.taskId;
	if (entered.length === 0)
		throw new Error(`No workflow node has entered autoresearch${describeNodes(specializations)}.`);
	// Several nodes qualify, so inferring one would silently pick a stage for the caller.
	throw new Error(
		`Several workflow nodes have entered autoresearch (${entered
			.map((entry) => entry.extension.taskId)
			.join(", ")}); name one with task_id.`,
	);
}

function describeNodes(specializations: readonly WorkflowTaskSpecializationProjection[]): string {
	if (specializations.length === 0) return "";
	const blocked = specializations
		.map((entry) => `${entry.extension.taskId}=${entry.base.statusTag ?? entry.base.phaseTag}`)
		.join(", ");
	return `: ${blocked}`;
}
