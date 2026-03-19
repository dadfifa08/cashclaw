import type {
  CateoArtifactContent,
  CateoArtifactSchemaRef,
  CateoArtifactType,
  CateoDiagnosticReasoningLog,
  CateoInspectionChecklist,
  CateoPartsToolsList,
  CateoServiceReport,
  CateoTroubleshootingProcedure,
} from "./types.js";

const SCHEMA_VERSIONS: Record<CateoArtifactType, CateoArtifactSchemaRef> = {
  "troubleshooting-procedure": { id: "cateo.troubleshooting-procedure", version: "1.0.0" },
  "inspection-checklist": { id: "cateo.inspection-checklist", version: "1.0.0" },
  "service-report": { id: "cateo.service-report", version: "1.0.0" },
  "parts-tools-list": { id: "cateo.parts-tools-list", version: "1.0.0" },
  "diagnostic-reasoning-log": { id: "cateo.diagnostic-reasoning-log", version: "1.0.0" },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pushTypeError(errors: string[], path: string, message: string): void {
  errors.push(`${path}: ${message}`);
}

function requireString(errors: string[], value: unknown, path: string): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    pushTypeError(errors, path, "expected non-empty string");
    return false;
  }
  return true;
}

function requireNumber(errors: string[], value: unknown, path: string): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushTypeError(errors, path, "expected finite number");
    return false;
  }
  return true;
}

function requireStringArray(errors: string[], value: unknown, path: string): value is string[] {
  if (!Array.isArray(value)) {
    pushTypeError(errors, path, "expected array");
    return false;
  }

  let ok = true;
  value.forEach((entry, index) => {
    if (!requireString(errors, entry, `${path}[${index}]`)) {
      ok = false;
    }
  });
  return ok;
}

function validateTroubleshootingProcedure(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) {
    return ["content: expected object"];
  }

  requireString(errors, value.title, "title");
  requireString(errors, value.objective, "objective");
  if (value.failureCode !== undefined && typeof value.failureCode !== "string") {
    pushTypeError(errors, "failureCode", "expected string when provided");
  }
  requireStringArray(errors, value.symptoms, "symptoms");
  requireStringArray(errors, value.assumptions, "assumptions");
  requireStringArray(errors, value.evidenceSummary, "evidenceSummary");
  requireStringArray(errors, value.safetyPrecautions, "safetyPrecautions");
  requireStringArray(errors, value.requiredParts, "requiredParts");
  requireStringArray(errors, value.requiredTools, "requiredTools");
  requireStringArray(errors, value.acceptanceCriteria, "acceptanceCriteria");
  requireStringArray(errors, value.followUpActions, "followUpActions");

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    pushTypeError(errors, "steps", "expected non-empty array");
  } else {
    value.steps.forEach((entry, index) => {
      if (!isObject(entry)) {
        pushTypeError(errors, `steps[${index}]`, "expected object");
        return;
      }
      requireString(errors, entry.id, `steps[${index}].id`);
      requireString(errors, entry.action, `steps[${index}].action`);
      requireString(errors, entry.rationale, `steps[${index}].rationale`);
      requireString(errors, entry.expectedResult, `steps[${index}].expectedResult`);
      if (entry.escalationTrigger !== undefined && typeof entry.escalationTrigger !== "string") {
        pushTypeError(errors, `steps[${index}].escalationTrigger`, "expected string when provided");
      }
    });
  }

  return errors;
}

function validateInspectionChecklist(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) {
    return ["content: expected object"];
  }

  requireString(errors, value.title, "title");
  requireString(errors, value.scope, "scope");
  requireStringArray(errors, value.prepSteps, "prepSteps");
  requireStringArray(errors, value.safetyNotes, "safetyNotes");
  requireStringArray(errors, value.completionCriteria, "completionCriteria");

  if (!Array.isArray(value.checklist) || value.checklist.length === 0) {
    pushTypeError(errors, "checklist", "expected non-empty array");
  } else {
    value.checklist.forEach((entry, index) => {
      if (!isObject(entry)) {
        pushTypeError(errors, `checklist[${index}]`, "expected object");
        return;
      }
      requireString(errors, entry.id, `checklist[${index}].id`);
      requireString(errors, entry.check, `checklist[${index}].check`);
      requireString(errors, entry.method, `checklist[${index}].method`);
      requireString(errors, entry.passCriteria, `checklist[${index}].passCriteria`);
      requireString(errors, entry.evidenceRequired, `checklist[${index}].evidenceRequired`);
      if (!["low", "medium", "high", "critical"].includes(String(entry.severityIfFailed))) {
        pushTypeError(errors, `checklist[${index}].severityIfFailed`, "expected low, medium, high, or critical");
      }
    });
  }

  return errors;
}

function validateServiceReport(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) {
    return ["content: expected object"];
  }
  requireString(errors, value.title, "title");
  requireString(errors, value.summary, "summary");
  requireStringArray(errors, value.findings, "findings");
  requireStringArray(errors, value.actionsPerformed, "actionsPerformed");
  requireStringArray(errors, value.unresolvedRisks, "unresolvedRisks");
  requireStringArray(errors, value.recommendations, "recommendations");
  requireString(errors, value.signoffRequirement, "signoffRequirement");
  return errors;
}

function validatePartsToolsList(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) {
    return ["content: expected object"];
  }
  requireString(errors, value.title, "title");
  requireStringArray(errors, value.consumables, "consumables");

  if (!Array.isArray(value.parts)) {
    pushTypeError(errors, "parts", "expected array");
  } else {
    value.parts.forEach((entry, index) => {
      if (!isObject(entry)) {
        pushTypeError(errors, `parts[${index}]`, "expected object");
        return;
      }
      requireString(errors, entry.sku, `parts[${index}].sku`);
      requireString(errors, entry.description, `parts[${index}].description`);
      requireNumber(errors, entry.quantity, `parts[${index}].quantity`);
      requireString(errors, entry.justification, `parts[${index}].justification`);
      if (entry.storageLocation !== undefined && typeof entry.storageLocation !== "string") {
        pushTypeError(errors, `parts[${index}].storageLocation`, "expected string when provided");
      }
    });
  }

  if (!Array.isArray(value.tools)) {
    pushTypeError(errors, "tools", "expected array");
  } else {
    value.tools.forEach((entry, index) => {
      if (!isObject(entry)) {
        pushTypeError(errors, `tools[${index}]`, "expected object");
        return;
      }
      requireString(errors, entry.name, `tools[${index}].name`);
      requireNumber(errors, entry.quantity, `tools[${index}].quantity`);
      requireString(errors, entry.purpose, `tools[${index}].purpose`);
    });
  }

  return errors;
}

function validateDiagnosticReasoningLog(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) {
    return ["content: expected object"];
  }

  requireString(errors, value.title, "title");
  requireString(errors, value.problemStatement, "problemStatement");
  requireStringArray(errors, value.assumptions, "assumptions");
  requireStringArray(errors, value.evidenceRequests, "evidenceRequests");
  requireString(errors, value.rootCauseStatement, "rootCauseStatement");
  if (!["low", "medium", "high"].includes(String(value.confidence))) {
    pushTypeError(errors, "confidence", "expected low, medium, or high");
  }

  if (!Array.isArray(value.hypotheses) || value.hypotheses.length === 0) {
    pushTypeError(errors, "hypotheses", "expected non-empty array");
  } else {
    value.hypotheses.forEach((entry, index) => {
      if (!isObject(entry)) {
        pushTypeError(errors, `hypotheses[${index}]`, "expected object");
        return;
      }
      requireString(errors, entry.name, `hypotheses[${index}].name`);
      if (!["candidate", "ruled-out", "confirmed"].includes(String(entry.status))) {
        pushTypeError(errors, `hypotheses[${index}].status`, "expected candidate, ruled-out, or confirmed");
      }
      requireStringArray(errors, entry.evidenceFor, `hypotheses[${index}].evidenceFor`);
      requireStringArray(errors, entry.evidenceAgainst, `hypotheses[${index}].evidenceAgainst`);
    });
  }

  return errors;
}

export function getSchemaRef(artifactType: CateoArtifactType): CateoArtifactSchemaRef {
  return SCHEMA_VERSIONS[artifactType];
}

export function validateArtifactContent(artifactType: CateoArtifactType, content: CateoArtifactContent): string[] {
  switch (artifactType) {
    case "troubleshooting-procedure":
      return validateTroubleshootingProcedure(content);
    case "inspection-checklist":
      return validateInspectionChecklist(content);
    case "service-report":
      return validateServiceReport(content);
    case "parts-tools-list":
      return validatePartsToolsList(content);
    case "diagnostic-reasoning-log":
      return validateDiagnosticReasoningLog(content);
    default:
      return ["content: unsupported artifact type"];
  }
}
