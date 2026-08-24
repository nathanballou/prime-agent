/** Fields a metric command must print so the host can measure without trusting the worker. */
export interface MetricCommandMeasurement {
	readonly metricValue: number;
	readonly baselineMetricValue: number;
	readonly sampleCount: number;
	readonly variance: number;
	/** Cost the evaluation actually incurred, when the command reports it. */
	readonly costMicrounits: number;
}

/** Why a metric command's output could not be used. Never silently coerced to a number. */
export interface MetricCommandRejection {
	readonly error: string;
}

/**
 * Read a measurement out of a metric command's stdout.
 *
 * Every failure returns a reason rather than a zero. The host this replaces reported metricValue 0
 * against baseline 1, with cost and latency derived from artifact byte length, while nothing ever ran
 * an evaluator — and a constant that reads as a measurement promotes silently, which is strictly worse
 * than an absent one.
 *
 * Args:
 * stdout: Raw stdout from the configured metric command.
 * Return: The measurement, or a rejection naming what was wrong.
 */
export function parseMetricCommandOutput(stdout: string): MetricCommandMeasurement | MetricCommandRejection {
	// Real tools print progress before their result, so take the last balanced object rather than
	// demanding the command print nothing else.
	const start = stdout.lastIndexOf("{");
	if (start === -1) return { error: "stdout is not canonical JSON" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.slice(start)) as unknown;
	} catch {
		return { error: "stdout is not canonical JSON" };
	}
	if (typeof parsed !== "object" || parsed === null) return { error: "stdout is not canonical JSON" };
	const record = parsed as Record<string, unknown>;
	const finite = (key: string): number | undefined => {
		const value = record[key];
		return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	};
	const metricValue = finite("metricValue");
	if (metricValue === undefined) return { error: "metricValue must be a finite number" };
	const baselineMetricValue = finite("baselineMetricValue");
	if (baselineMetricValue === undefined) return { error: "baselineMetricValue must be a finite number" };
	const sampleCount = record.sampleCount;
	if (!Number.isSafeInteger(sampleCount) || (sampleCount as number) < 1)
		return { error: "sampleCount must be a positive integer" };
	const variance = finite("variance");
	if (variance === undefined || variance < 0) return { error: "variance must be a non-negative finite number" };
	// Optional, and 0 when unreported. A downstream cost ceiling compares against this, so a command
	// that stays silent about cost is treated as free - which is a claim, not a measurement. Reporting
	// it is how an operator makes that ceiling mean anything.
	const reportedCost = record.costMicrounits;
	if (reportedCost !== undefined && (!Number.isSafeInteger(reportedCost) || (reportedCost as number) < 0))
		return { error: "costMicrounits must be a non-negative integer when present" };
	return {
		metricValue,
		baselineMetricValue,
		sampleCount: sampleCount as number,
		variance,
		costMicrounits: (reportedCost as number | undefined) ?? 0,
	};
}
