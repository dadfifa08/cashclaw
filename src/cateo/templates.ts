import type { CateoArtifactType, CateoInstructionTemplate, CateoTaskClass } from "./types.js";
import { loadTroubleshootingRulesDocument } from "./rules_document.js";

const TEMPLATE_VERSION = "1.2.0";

function uniqueArtifacts(values: CateoArtifactType[]): CateoArtifactType[] {
  return [...new Set(values)];
}

function baseTemplate(taskClass: CateoTaskClass, requiredArtifacts: CateoArtifactType[]): CateoInstructionTemplate {
  const template: CateoInstructionTemplate = {
    templateId: `cateo.${taskClass}`,
    version: TEMPLATE_VERSION,
    taskClass,
    responseBehavior: [
      "Stay grounded in provided evidence, prior artifacts, known machine context, and verified external references before using general reasoning.",
      "Produce engineering-grade structured content that can be stored as a controlled artifact.",
      "Prefer deterministic steps, explicit assumptions, bounded conclusions, and cited source-backed details over conversational filler.",
    ],
    terminology: [
      "Use subsystem, interface, input, output, control logic, failure mode, acceptance criteria, and verification language.",
      "State units, thresholds, and pass/fail conditions when practical.",
    ],
    fieldExpectations: [
      "Include a concrete problem definition, system context, observed conditions, assumptions, and ranked hypotheses.",
      "Include recommended actions, validation procedures, risk implications, provenance-ready references, and explicit hazards when available.",
      "Use manufacturer, OEM, manual, datasheet, or other verified references when they materially improve specificity.",
      "Do not leave confidence, risk, expected values, or follow-up actions implicit.",
    ],
    outputConstraints: [
      "Return schema-compatible JSON only for the stage contract.",
      "Avoid unsupported claims, hidden leaps, vague release-to-service recommendations, or generic filler detached from the evidence.",
      "Keep the output suitable for audit logging, revision history, and downstream analytics.",
    ],
    requiredArtifacts: uniqueArtifacts(requiredArtifacts),
  };

  if (taskClass === "troubleshooting" || taskClass === "mixed" || taskClass === "root-cause-analysis") {
    template.controlledRulesDocument = loadTroubleshootingRulesDocument();
    template.outputConstraints = [
      ...template.outputConstraints,
      "Follow the controlled troubleshooting rules document when producing or revising troubleshooting content.",
    ];
  }

  return template;
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
