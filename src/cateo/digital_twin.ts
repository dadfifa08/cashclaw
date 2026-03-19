import type {
  CateoDigitalTwinInput,
  CateoDigitalTwinPointResult,
  CateoDigitalTwinResult,
} from "./types.js";

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function vectorLength(values: number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

function subtract(left: number[], right: number[]): number[] {
  const width = Math.max(left.length, right.length);
  return Array.from({ length: width }, (_, index) => (left[index] ?? 0) - (right[index] ?? 0));
}

function centroid(points: number[][]): number[] {
  if (points.length === 0) return [];
  const axisCount = Math.max(...points.map((point) => point.length));
  return Array.from({ length: axisCount }, (_, axis) => round(points.reduce((sum, point) => sum + (point[axis] ?? 0), 0) / points.length));
}

function span(points: number[][]): number[] {
  if (points.length === 0) return [];
  const axisCount = Math.max(...points.map((point) => point.length));
  return Array.from({ length: axisCount }, (_, axis) => {
    const axisValues = points.map((point) => point[axis] ?? 0);
    return round(Math.max(...axisValues) - Math.min(...axisValues));
  });
}

function buildPointChecks(input: CateoDigitalTwinInput | undefined): CateoDigitalTwinPointResult[] {
  return (input?.points ?? []).map((point) => {
    const distance = round(vectorLength(subtract(point.observed, point.expected)));
    return {
      name: point.name,
      unit: point.unit,
      distance,
      toleranceAbs: point.toleranceAbs,
      pass: distance <= point.toleranceAbs,
    };
  });
}

export function analyzeDigitalTwin(input: CateoDigitalTwinInput | undefined): CateoDigitalTwinResult | null {
  if (!input) {
    return null;
  }

  const dimensionChecks = (input.dimensions ?? []).map((dimension) => {
    const deviationAbs = round(Math.abs(dimension.observed - dimension.expected));
    const deviationPct = dimension.expected === 0 ? 0 : round((deviationAbs / Math.abs(dimension.expected)) * 100);
    const toleranceAbs = round(
      dimension.toleranceAbs
        ?? (dimension.tolerancePct !== undefined
          ? Math.abs(dimension.expected) * (dimension.tolerancePct / 100)
          : Math.max(0.5, Math.abs(dimension.expected) * 0.02)),
    );

    return {
      name: dimension.name,
      expected: round(dimension.expected),
      observed: round(dimension.observed),
      unit: dimension.unit,
      deviationAbs,
      deviationPct,
      toleranceAbs,
      pass: deviationAbs <= toleranceAbs,
    };
  });

  const pointChecks = buildPointChecks(input);
  const observedPoints = (input.points ?? []).map((point) => point.observed);
  const expectedPoints = (input.points ?? []).map((point) => point.expected);
  const observedCentroid = centroid(observedPoints);
  const expectedCentroid = centroid(expectedPoints);
  const centroidShift = subtract(observedCentroid, expectedCentroid).map(round);
  const flaggedFeatures = [
    ...dimensionChecks.filter((entry) => !entry.pass).map((entry) => `${entry.name} dimension out of tolerance`),
    ...pointChecks.filter((entry) => !entry.pass).map((entry) => `${entry.name} point misalignment`),
  ];

  const notes: string[] = [];
  if (dimensionChecks.length > 0) {
    notes.push(`Checked ${dimensionChecks.length} dimensional tolerances against the expected state.`);
  }
  if (pointChecks.length > 0) {
    notes.push(`Aligned ${pointChecks.length} reference points against the expected geometry.`);
  }
  if (flaggedFeatures.length === 0) {
    notes.push("No digital-twin deviations exceeded the configured tolerance thresholds.");
  }

  return {
    referenceModelId: input.referenceModelId,
    expectedStateLabel: input.expectedStateLabel,
    status: flaggedFeatures.length > 0 ? "fail" : (dimensionChecks.length === 0 && pointChecks.length === 0 ? "not-run" : "pass"),
    reconstructedEnvelope: observedPoints.length > 0
      ? {
          axisCount: Math.max(...observedPoints.map((point) => point.length)),
          span: span(observedPoints),
          centroidShift,
        }
      : undefined,
    dimensionChecks,
    pointChecks,
    flaggedFeatures,
    notes,
  };
}
