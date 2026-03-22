import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config.js";

const DEFAULT_RULES_DOCUMENT = `# Cateo V0 Troubleshooting Output Rules

## Objective
Produce one controlled troubleshooting report package per request. The customer sees a concise conversational answer, but the underlying procedure must remain engineering-grade, deterministic where possible, and reusable as a dataset artifact.

## Required report sections
1. Document control
2. Problem definition
3. System and part identification
4. Observed conditions and evidence summary
5. Assumptions and constraints
6. Step-by-step diagnostics
7. Expected values, pass criteria, and failure paths
8. Probable root cause and confidence
9. Corrective actions and verification steps
10. Preventive maintenance or recurrence controls
11. Parts, tools, and references

## Output rules
- Prefer troubleshooting procedures, diagnostic reasoning, service summaries, and parts/tools data over general prose.
- Use explicit values, ranges, thresholds, or pass-fail criteria whenever the evidence supports them.
- If the manufacturer part number is uncertain, ask a clarifying question instead of inventing the identity.
- Every step must include why the step matters and what result is expected.
- Root-cause statements must be bounded by confidence and supporting evidence.
- Separate verified findings from assumptions.
- Reference attachments, prior service history, and verified sources when they materially influence the recommendation.
- Keep customer-facing language readable, but never drop the controlled procedure structure in the stored report package.

## Prohibited behavior
- Do not fabricate expected values, specs, part numbers, or service history.
- Do not recommend return to service without a verification step.
- Do not hide uncertainty.
- Do not emit marketing copy in the report body.
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
