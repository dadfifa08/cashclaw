import type { CateoArtifactType, CateoInstructionTemplate, CateoTaskClass } from "./types.js";
import { loadTroubleshootingRulesDocument } from "./rules_document.js";

const TEMPLATE_VERSION = "1.5.0";

function uniqueArtifacts(values: CateoArtifactType[]): CateoArtifactType[] {
  return [...new Set(values)];
}

function baseTemplate(taskClass: CateoTaskClass, requiredArtifacts: CateoArtifactType[]): CateoInstructionTemplate {
  const template: CateoInstructionTemplate = {
    templateId: `cateo.${taskClass}`,
    version: TEMPLATE_VERSION,
    taskClass,
    responseBehavior: [
      "Stay grounded in verified external references, provided evidence, prior artifacts, and known machine context before using general reasoning.",
      "Treat manufacturer, OEM, manual, datasheet, standards, and service-bulletin evidence as the primary guidance layer. Use field history, prior cases, and crowdsource improvements only as secondary refinement layers.",
      "Produce engineering-grade structured content that can be stored as a controlled artifact while still reading like a natural service guide for the customer.",
    ],
    terminology: [
      "Use subsystem, interface, input, output, control logic, failure mode, acceptance criteria, and verification language.",
      "Write troubleshooting actions in direct, imperative sentences that resemble a service manual, field bulletin, or technical work instruction.",
      "State units, thresholds, and pass/fail conditions when practical.",
    ],
    fieldExpectations: [
      "Include a concrete problem definition, system context, observed conditions, assumptions, and ranked hypotheses.",
      "Include recommended actions, validation procedures, risk implications, provenance-ready references, and explicit hazards when available.",
      "For troubleshooting outputs, produce a guide with a summary, required tools, estimated time required, hazards present, required parts, numbered troubleshooting steps, validation and verification steps, and a version-control stamp.",
      "In troubleshooting steps, name referenced part numbers, tool names, expected results, and escalation triggers whenever the evidence supports them.",
      "When verified sources exist, build the procedure from them first and only then layer in field history or crowdsource corrections as refinement.",
      "Keep backend metadata, traceability, and CPLM detail in the structured package, not as the dominant voice of the customer-facing guide.",
      "Do not leave confidence, risk, expected values, or follow-up actions implicit.",
    ],
    outputConstraints: [
      "Return schema-compatible JSON only for the stage contract.",
      "Avoid unsupported claims, hidden leaps, vague release-to-service recommendations, or generic filler detached from the evidence.",
      "Do not collapse the troubleshooting guide into high-level summary prose when concrete stepwise instructions can be produced from the evidence.",
      "Do not let backend metadata dominate the customer-facing narrative. The user should receive a readable guided procedure first.",
      "Keep the output suitable for audit logging, revision history, downstream analytics, and deterministic rendering into Word/PDF guide sections.",
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
