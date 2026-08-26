import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import type { DurableApprovalSecretProof, WorkflowApprovalRequest } from "../src/core/workflow/contracts.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
} from "../src/core/workflow/session-host-factory.js";

const GENESIS_EPOCH = { storeEpoch: 1, coordinatorEpoch: 1 } as const;
const START_TIME_MS = Date.parse("2030-01-01T00:00:00.000Z");

interface CapturedDelivery {
	readonly request: WorkflowApprovalRequest;
	readonly proofs: Readonly<Record<string, DurableApprovalSecretProof>>;
}

interface ExpiryHarness {
	host: PersistedSessionWorkflowHost;
	deliveries: CapturedDelivery[];
	artifactRoot: string;
	advanceLogicalClock(milliseconds: number): void;
	renewLeaseHeartbeat(): Promise<void>;
	dispose(): Promise<void>;
}

async function createExpiryHarness(): Promise<ExpiryHarness> {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-approval-expiry-remint-"));
	let nowMs = START_TIME_MS;
	let goal: GoalState = emptyGoalState();
	const deliveries: CapturedDelivery[] = [];
	// Only the lease-heartbeat interval is faked; the logical workflow clock is the
	// injected now() below, advanced explicitly to walk the approval past its expiry.
	vi.useFakeTimers({ toFake: ["setInterval"] });
	const host = await createPersistedSessionWorkflowHost({
		artifactRoot,
		rootSessionId: "session-expiry",
		workflowId: "workflow-expiry",
		genesisEpoch: GENESIS_EPOCH,
		now: () => new Date(nowMs).toISOString(),
		goalProjection: {
			read: (): GoalState => structuredClone(goal),
			compareAndSwap: (expected: GoalState, next: GoalState): boolean => {
				if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
				goal = structuredClone(next);
				return true;
			},
		},
		approvalSecretDelivery: ({ request, proofs }) => {
			deliveries.push({ request: structuredClone(request), proofs: structuredClone(proofs) });
		},
	});
	return {
		host,
		deliveries,
		artifactRoot,
		advanceLogicalClock: (milliseconds: number) => {
			nowMs += milliseconds;
		},
		renewLeaseHeartbeat: async () => {
			vi.advanceTimersByTime(60_000);
			await new Promise((resolve) => setTimeout(resolve, 25));
		},
		dispose: async () => {
			await host.dispose?.();
			vi.useRealTimers();
			await rm(artifactRoot, { recursive: true, force: true });
		},
	};
}

async function startAwaitingApproval(harness: ExpiryHarness): Promise<WorkflowApprovalRequest> {
	const started = await harness.host.execute({
		kind: "start",
		request: {
			workflowId: "workflow-expiry",
			objective: "survive an expired approval credential",
			acceptanceChecks: ["fresh-credential"],
			protectedInvariants: ["no-plaintext-approval"],
		},
	});
	expect(started.status).toBe("awaiting_user");
	expect(started.approvalRequest).not.toBeNull();
	expect(harness.deliveries).toHaveLength(1);
	return started.approvalRequest as WorkflowApprovalRequest;
}

async function expireApproval(harness: ExpiryHarness): Promise<void> {
	// The approval TTL is 300s. Renew the append lease mid-way so only the
	// credential is expired when the logical clock passes the deadline.
	harness.advanceLogicalClock(250_000);
	await harness.renewLeaseHeartbeat();
	harness.advanceLogicalClock(60_000);
}

afterEach(() => {
	vi.useRealTimers();
});

it("re-mints a fresh credential and instructs a retry when a respond hits an expired approval", async () => {
	const harness = await createExpiryHarness();
	try {
		const request = await startAwaitingApproval(harness);
		await expireApproval(harness);

		const failure = await harness.host
			.execute({
				kind: "respond",
				approvalRequestId: request.approvalRequestId,
				optionId: "approve",
				proof: harness.deliveries[0]!.proofs.approve!,
			})
			.then(
				() => undefined,
				(error: unknown) => error as Error,
			);
		expect(failure).toBeInstanceOf(Error);
		expect(failure!.message).toMatch(/expired/i);
		expect(failure!.message).toMatch(/fresh credential/i);
		expect(failure!.message).toMatch(/retry/i);

		expect(harness.deliveries).toHaveLength(2);
		const reminted = harness.deliveries[1]!.request;
		expect(reminted.approvalRequestId).not.toBe(request.approvalRequestId);
		expect(reminted.expectedResponseSequence).toBe(request.expectedResponseSequence + 1);
		expect(Date.parse(reminted.expiresAt)).toBeGreaterThan(Date.parse(request.expiresAt));

		const status = await harness.host.execute({ kind: "status" });
		expect(status.status).toBe("awaiting_user");
		expect(status.approvalRequest?.approvalRequestId).toBe(reminted.approvalRequestId);
	} finally {
		await harness.dispose();
	}
});

it("approves the workflow with the re-minted credential on retry", async () => {
	const harness = await createExpiryHarness();
	try {
		const request = await startAwaitingApproval(harness);
		await expireApproval(harness);
		await harness.host
			.execute({
				kind: "respond",
				approvalRequestId: request.approvalRequestId,
				optionId: "approve",
				proof: harness.deliveries[0]!.proofs.approve!,
			})
			.catch(() => undefined);
		expect(harness.deliveries).toHaveLength(2);

		const reminted = harness.deliveries[1]!;
		const approved = await harness.host.execute({
			kind: "respond",
			approvalRequestId: reminted.request.approvalRequestId,
			optionId: "approve",
			proof: reminted.proofs.approve!,
		});
		expect(approved.status).toBe("active");
	} finally {
		await harness.dispose();
	}
});

it("does not re-mint when the respond fails for a reason other than expiry", async () => {
	const harness = await createExpiryHarness();
	try {
		const request = await startAwaitingApproval(harness);

		const failure = await harness.host
			.execute({
				kind: "respond",
				approvalRequestId: request.approvalRequestId,
				optionId: "approve",
				proof: { ...harness.deliveries[0]!.proofs.approve!, oneUseSecret: "forged-secret" },
			})
			.then(
				() => undefined,
				(error: unknown) => error as Error,
			);
		expect(failure).toBeInstanceOf(Error);
		expect(harness.deliveries).toHaveLength(1);

		const status = await harness.host.execute({ kind: "status" });
		expect(status.status).toBe("awaiting_user");
		expect(status.approvalRequest?.approvalRequestId).toBe(request.approvalRequestId);
	} finally {
		await harness.dispose();
	}
});
