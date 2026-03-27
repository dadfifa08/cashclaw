import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config.js";

const DEFAULT_RULES_DOCUMENT = `# Cateo V1.2 Troubleshooting Output Rules

## Objective
Produce one controlled troubleshooting guide per request. The customer should receive a readable field guide that behaves like a service manual or technical bulletin. The deeper metadata, traceability, and CPLM structure must still be preserved in the stored package, but they should not dominate the customer-facing narrative.

## Required report sections
1. Summary
2. Required tools
3. Estimated time required
4. Hazards present, lockout/readiness checks, and other safety labels
5. Parts required for troubleshooting, inspection, or replacement
6. Numbered step-by-step troubleshooting guide with rationale, expected results, and escalation triggers
7. Validation and verification steps
8. Source basis and reference set
9. Version control stamp

## Source hierarchy
- Use verified manufacturer, OEM, service-manual, datasheet, standard, and service-bulletin sources as the primary guidance layer whenever they exist.
- Use field history, prior cases, and approved crowdsource improvements only after the verified-source layer is established.
- When secondary field or crowdsource information changes the path, make it a refinement note or branch in the guide rather than the primary justification.
- If no verified source set is available, say so clearly and keep the guide provisional.

## Output rules
- Make the customer-facing output read like a real troubleshooting guide rather than a narrative summary or metadata dump.
- Write steps in natural imperative language, one clear action at a time, with a short reason and the expected result.
- Keep each section explicit even when the available evidence is limited or the guide is only a first-pass draft.
- Include required tools, estimated time required, hazards present, parts required, numbered troubleshooting steps, and validation/verification steps whenever troubleshooting content is produced.
- If a field is unknown, label it as unknown or estimated instead of inventing it.
- Explicitly label estimated time as an estimate when it is not directly source-backed.
- Every troubleshooting step must state why the step matters and what result is expected.
- When evidence supports it, call out specific part numbers, tool names, thresholds, pass-fail criteria, hazard labels, and escalation triggers.
- Root-cause statements must stay bounded by confidence and supporting evidence, but keep them in the structured package instead of letting them overwhelm the user guide.
- Separate verified findings from assumptions.
- Reference attachments, prior service history, verified sources, and approved crowdsource improvements when they materially influence the recommendation.
- End every troubleshooting report with a version control stamp that includes document ID, package/template version, release status, generated time, and updated time.

## Prohibited behavior
- Do not fabricate expected values, specs, part numbers, service history, time estimates, hazard statements, or source-backed claims.
- Do not recommend return to service without a verification step.
- Do not hide uncertainty.
- Do not emit marketing copy or backend-admin metadata as the main body of the guide.
`;

export interface CateoRulesDocument {
  path: string;
  content: string;
}

export function getTroubleshootingRulesDocumentPath(): string {
  return path.join(getConfigDir(), "cateo", "templates", "troubleshooting-rules.md");
}

export function loadTroubleshootingRulesDocument(): CateoRulesDocument {
  const filePath = getTroubleshootingRulesDocumentPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, DEFAULT_RULES_DOCUMENT, { encoding: "utf8", mode: 0o600 });
  }

  const content = fs.readFileSync(filePath, "utf8").trim() || DEFAULT_RULES_DOCUMENT.trim();
  return {
    path: filePath,
    content,
  };
}
