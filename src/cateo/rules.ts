import type {
  CateoArtifactRecord,
  CateoBuilderPackage,
  CateoContextBundle,
  CateoFinalSynthesis,
  CateoInstructionTemplate,
  CateoReviewerDecision,
  CateoRuleResult,
} from "./types.js";

function hasQuantitativeSignal(values: string[]): boolean {
  return values.some((value) => /\b\d+(?:\.\d+)?\s?(?:mm|cm|m|in|ft|c|°c|f|°f|v|a|ma|bar|psi|rpm|hz|%|pct|hours?|mins?|seconds?)\b|\b\d+(?:\.\d+)?\b|±|within|tolerance|limit/i.test(value));
}

function includesRiskyReleaseLanguage(values: string[]): boolean {
  return values.some((value) => /(return to service|resume operation|continue running|approve release)/i.test(value));
}

export function evaluateArtifactPackageRules(args: {
  template: CateoInstructionTemplate;
  context: CateoContextBundle;
  builderPackage: CateoBuilderPackage;
  reviewerDecision: CateoReviewerDecision;
  finalSynthesis: CateoFinalSynthesis;
}): CateoRuleResult[] {
  const results: CateoRuleResult[] = [];

  for (const draft of args.builderPackage.artifactDrafts) {
    const content = draft.content as unknown as Record<string, unknown>;
    const quantitativeValues = Object.values(content)
      .flatMap((entry) => Array.isArray(entry) ? entry.filter((value): value is string => typeof value === "string") : typeof entry === "string" ? [entry] : []);

    if (!hasQuantitativeSignal(quantitativeValues)) {
      results.push({
        ruleId: "quantitative_criteria_required",
        severity: "warn",
        outcome: "flag",
        artifactType: draft.artifactType,
        message: `${draft.artifactType} is missing measurable thresholds, limits, or explicit pass/fail language.`,
      });
    }
  }

  const reasoning = args.builderPackage.artifactDrafts.find((draft) => draft.artifactType === "diagnostic-reasoning-log");
  const reasoningContent = reasoning?.content as { confidence?: string; evidenceRequests?: string[]; hypotheses?: Array<{ evidenceFor?: string[] }> } | undefined;
  if (reasoningContent?.confidence === "high") {
    const evidenceCount = (reasoningContent.evidenceRequests ?? []).length + (reasoningContent.hypotheses ?? []).reduce((sum, entry) => sum + (entry.evidenceFor?.length ?? 0), 0);
    if (evidenceCount < 2) {
      results.push({
        ruleId: "high_confidence_requires_evidence",
        severity: "error",
        outcome: "escalate",
        artifactType: "diagnostic-reasoning-log",
        message: "High-confidence reasoning requires stronger explicit evidence before approval.",
      });
    }
  }

  if (args.finalSynthesis.confidence === "low") {
    results.push({
      ruleId: "low_confidence_review_gate",
      severity: "warn",
      outcome: "escalate",
      message: "Low-confidence results must remain draft and require explicit follow-up.",
    });
  }

  const releaseLanguage = [
    ...args.finalSynthesis.nextActions,
    ...args.finalSynthesis.operatorNotes,
    args.finalSynthesis.rootCauseStatement,
  ];
  if (includesRiskyReleaseLanguage(releaseLanguage) && !hasQuantitativeSignal(releaseLanguage)) {
    results.push({
      ruleId: "release_language_requires_acceptance_criteria",
      severity: "error",
      outcome: "escalate",
      message: "Release-to-service language was detected without measurable acceptance criteria.",
    });
  }

  if (args.context.failureCode && !args.builderPackage.artifactDrafts.some((draft) => JSON.stringify(draft.content).includes(args.context.failureCode?.code ?? ""))) {
    results.push({
      ruleId: "failure_code_traceability",
      severity: "warn",
      outcome: "flag",
      message: `Failure code ${args.context.failureCode.code} should be referenced explicitly in the artifact package.`,
    });
  }

  if (args.reviewerDecision.approvalState === "approved") {
    results.push({
      ruleId: "approval_state_capped",
      severity: "info",
      outcome: "flag",
      message: "Cateo caps automated reviewer outcomes at reviewed; final approval remains an operator action.",
    });
  }

  return results;
}

export function summarizeRuleOutcomes(results: CateoRuleResult[]): { flagged: number; escalated: number; failedValidation: number } {
  return {
    flagged: results.filter((entry) => entry.outcome === "flag").length,
    escalated: results.filter((entry) => entry.outcome === "escalate").length,
    failedValidation: results.filter((entry) => entry.severity === "error").length,
  };
}

export function countArtifactRevisions(records: CateoArtifactRecord[]): number {
  return records.reduce((sum, record) => sum + record.revisions.length, 0);
}
