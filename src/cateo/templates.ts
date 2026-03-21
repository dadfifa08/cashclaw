import type { CateoArtifactType, CateoInstructionTemplate, CateoTaskClass } from "./types.js";

const TEMPLATE_VERSION = "1.0.0";

function uniqueArtifacts(values: CateoArtifactType[]): CateoArtifactType[] {
  return [...new Set(values)];
}

function baseTemplate(taskClass: CateoTaskClass, requiredArtifacts: CateoArtifactType[]): CateoInstructionTemplate {
  return {
    templateId: `cateo.${taskClass}`,
    version: TEMPLATE_VERSION,
    taskClass,
    responseBehavior: [
      "Stay grounded in provided evidence, prior artifacts, and known machine context before using general reasoning.",
      "Produce engineering-grade structured content that can be stored as a controlled artifact.",
      "Prefer deterministic steps, explicit assumptions, and bounded conclusions over conversational filler.",
    ],
    terminology: [
      "Use subsystem, interface, input, output, control logic, failure mode, acceptance criteria, and verification language.",
      "State units, thresholds, and pass/fail conditions when practical.",
    ],
    fieldExpectations: [
      "Include a concrete problem definition, system context, observed conditions, assumptions, and ranked hypotheses.",
      "Include recommended actions, validation procedures, risk implications, and provenance-ready references.",
      "Do not leave confidence, risk, or follow-up actions implicit.",
    ],
    outputConstraints: [
      "Return schema-compatible JSON only for the stage contract.",
      "Avoid unsupported claims, hidden leaps, or vague release-to-service recommendations.",
      "Keep the output suitable for audit logging, revision history, and downstream analytics.",
    ],
    requiredArtifacts: uniqueArtifacts(requiredArtifacts),
  };
}

const TEMPLATES: Record<CateoTaskClass, CateoInstructionTemplate> = {
  inspection: baseTemplate("inspection", ["inspection-checklist", "service-report", "diagnostic-reasoning-log"]),
  troubleshooting: baseTemplate("troubleshooting", ["troubleshooting-procedure", "service-report", "diagnostic-reasoning-log", "parts-tools-list"]),
  "preventive-maintenance": baseTemplate("preventive-maintenance", ["inspection-checklist", "service-report", "parts-tools-list"]),
  "root-cause-analysis": baseTemplate("root-cause-analysis", ["diagnostic-reasoning-log", "service-report", "troubleshooting-procedure"]),
  documentation: baseTemplate("documentation", ["service-report", "diagnostic-reasoning-log"]),
  mixed: baseTemplate("mixed", ["service-report", "diagnostic-reasoning-log", "inspection-checklist", "troubleshooting-procedure"]),
};

export function getInstructionTemplate(taskClass: CateoTaskClass, requestedArtifacts: CateoArtifactType[] = []): CateoInstructionTemplate {
  const base = TEMPLATES[taskClass] ?? TEMPLATES.mixed;
  return {
    ...base,
    requiredArtifacts: uniqueArtifacts([...base.requiredArtifacts, ...requestedArtifacts]),
  };
}

export function renderInstructionTemplate(template: CateoInstructionTemplate): string {
  return JSON.stringify(template, null, 2);
}
