import { describe, expect, it } from "vitest";
import { formatWorkflowStatusText } from "../src/cli/daemon-command.js";
import type { DaemonWorkflowStatusProjection, SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const NOW_MS = Date.parse("2026-08-25T22:00:00.000Z");

function makeSummary(workflowStatus: DaemonWorkflowStatusProjection): SessionSummary {
	return {
		id: "0000aaaabbbb",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: true,
		sessionId: "0000aaaabbbb",
		activeSessionId: "0000aaaabbbb",
		sessionName: "forex-research-5",
		cwd: "/tmp/project",
		workflowStatus,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 2,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function awaitingProjection(expiresAt: string): DaemonWorkflowStatusProjection {
	return {
		workflowId: "workflow-1",
		status: "awaiting_user",
		phase: "adjudicating",
		nextGate: null,
		nextTask: null,
		blocker: null,
		headDigest: "head-1",
		objective: "Ship the forex research program",
		tasks: [
			{ taskId: "verify-model", role: "verification" },
			{ taskId: "attack-model", role: "red-team" },
		],
		approvalRequest: {
			approvalRequestId: "approval-1",
			question: "Approve the exact objective and budgets?",
			expiresAt,
			expectedResponseSequence: 1,
			headDigest: "head-1",
			stateDigest: "state-1",
			options: [
				{ optionId: "approve", label: "Approve", effectDigest: "effect-1" },
				{ optionId: "decline", label: "Decline", effectDigest: "effect-2" },
			],
		},
	};
}

describe("workflow status text for a pending approval", () => {
	it("shows the proposal, the deadline countdown, and the exact commands to act", () => {
		const text = formatWorkflowStatusText(makeSummary(awaitingProjection("2026-08-25T22:04:10.000Z")), NOW_MS);
		expect(text).toContain("Blocker: awaiting human approval (expires in 4m10s)");
		expect(text).toContain("Objective: Ship the forex research program");
		expect(text).toContain("verify-model (verification)");
		expect(text).toContain("attack-model (red-team)");
		expect(text).toContain("Approval: approval-1");
		expect(text).toContain("Question: Approve the exact objective and budgets?");
		expect(text).toContain("Options: approve, decline");
		expect(text).toContain("Expires: 2026-08-25T22:04:10.000Z (in 4m10s)");
		expect(text).toContain("prime-agent workflow approve forex-research-5");
		expect(text).toContain("prime-agent workflow reject forex-research-5");
	});

	it("says the credential expired and that approving mints a fresh one", () => {
		const text = formatWorkflowStatusText(makeSummary(awaitingProjection("2026-08-25T19:00:00.000Z")), NOW_MS);
		expect(text).toContain(
			"Blocker: awaiting human approval (credential expired 3h0m ago; approving mints a fresh credential)",
		);
		expect(text).toContain("Expires: 2026-08-25T19:00:00.000Z (expired 3h0m ago)");
	});

	it("keeps the plain blocker line when no approval is pending", () => {
		const text = formatWorkflowStatusText(
			makeSummary({
				workflowId: "workflow-1",
				status: "active",
				phase: "executing",
				nextGate: null,
				nextTask: null,
				blocker: null,
				headDigest: "head-1",
				approvalRequest: null,
			}),
			NOW_MS,
		);
		expect(text).toContain("Blocker: none");
		expect(text).not.toContain("Approval:");
		expect(text).not.toContain("prime-agent workflow approve");
	});
});
