import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const baseUrl = process.env.CATEO_SMOKE_BASE_URL?.trim() || "https://www.cateo.org";
const stamp = Date.now().toString().slice(-6);
const cateoDir = path.join(os.homedir(), ".cashclaw", "cateo");
const reportDir = path.join(cateoDir, "report_packages");
const caseDir = path.join(cateoDir, "cases");
const artifactDir = path.join(cateoDir, "artifacts");
const outputDir = path.join("C:/Users/dadfi/Projects/cashclaw/ops", "smoke-results");
fs.mkdirSync(outputDir, { recursive: true });

const scenarios = [
  ["Analyzer startup self-test failure after preventive maintenance", "clinical-diagnostics", "Analyzer X", "startup-shutdown"],
  ["Pressure sensor drift after calibration event", "medical-devices", "Pressure Module", "calibration-drift"],
  ["PLC communication loss after cabinet power cycle", "industrial-manufacturing", "PLC Rack", "communication-network"],
  ["Motor controller undervoltage fault during startup", "automotive", "Motor Drive", "power-electrical"],
  ["Encoder signal drop on conveyor indexing station", "food-beverage", "Conveyor Station", "sensor-signal"],
  ["Valve actuation delay under batch load", "chemical-processing", "Valve Manifold", "performance-deviation"],
  ["Firmware update boot fault on embedded controller", "software-systems", "Embedded Controller", "software-firmware"],
  ["Clean-room pressure alarm after filter change", "pharmaceutical-manufacturing", "Room Pressure Monitor", "fault-alarm"],
  ["Bearing replacement followed by motor overtemperature", "energy-utilities", "Pump Motor", "mechanical-wear"],
  ["Verification criteria missed during deviation follow-up", "general-engineering", "Verification Fixture", "quality-compliance"],
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function countFiles(root, fileName) {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (!fileName || entry.name === fileName) count += 1;
    }
  }
  return count;
}
async function getJson(url, headers) {
  const response = await fetch(url, { headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}
async function postForm(url, headers, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") form.set(key, String(value));
  }
  const response = await fetch(url, { method: "POST", headers, body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}
async function waitForJob(clientId, jobId) {
  const headers = { "X-Cateo-Client-Id": clientId };
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    const payload = await getJson(`${baseUrl}/api/chat?jobId=${encodeURIComponent(jobId)}`, headers);
    const job = payload.job;
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status === "completed") return payload;
    if (job.status === "failed") throw new Error(job.error || `Job ${jobId} failed`);
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function waitForReport(clientId, conversationId) {
  const headers = { "X-Cateo-Client-Id": clientId };
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await getJson(`${baseUrl}/api/site/conversations/${encodeURIComponent(conversationId)}`, headers);
      return await getJson(`${baseUrl}/api/site/conversations/${encodeURIComponent(conversationId)}/report`, headers);
    } catch (error) {
      lastError = error;
      await sleep(5000);
    }
  }
  throw lastError || new Error(`Timed out waiting for report for ${conversationId}`);
}

const before = {
  cases: countFiles(caseDir),
  artifacts: countFiles(artifactDir),
  reports: countFiles(reportDir, "troubleshooting-report.json"),
};
const results = [];

for (let index = 0; index < scenarios.length; index += 1) {
  const [description, businessType, systemName, issueType] = scenarios[index];
  const clientId = `cateo-smoke-${stamp}-${String(index + 1).padStart(2, "0")}`;
  const partNumber = `SMK-${stamp}-${String(index + 1).padStart(2, "0")}`;
  const headers = { "X-Cateo-Client-Id": clientId };
  const submission = await postForm(`${baseUrl}/api/chat`, headers, {
    message: `${description}. Provide an engineering troubleshooting report with expected values, likely root cause, and verification steps.`,
    taskMode: "troubleshooting",
    artifactFocus: "troubleshooting-procedure",
    productOffering: "troubleshooting-guide",
    workflowMode: "chat",
    responseStyle: "detailed",
    documentIntent: "Draft an engineering-grade troubleshooting report with document control, diagnostics, expected values, failure paths, likely root cause, and verification steps.",
    businessType,
    machineModel: `${systemName} ${stamp}`,
    partNumber,
    issueType,
    workOrderId: `WO-${stamp}-${index + 1}`,
    errorCode: `ERR-${stamp}-${index + 1}`,
    assetId: `AST-${stamp}-${index + 1}`,
    manufacturer: "Cateo Smoke Labs",
    location: `Line ${index + 1}`,
    environment: index % 2 === 0 ? "controlled" : "process-area",
    observedConditions: `Observed condition set ${index + 1}: intermittent fault, operator reproduced after reset, no permanent recovery yet.`,
    contextNotes: `Smoke validation case ${index + 1}. Use deterministic troubleshooting structure and concrete verification criteria.`,
  });

  const conversationId = submission.conversation?.conversationId;
  const jobId = submission.job?.jobId || submission.job?.job?.jobId || submission.job?.id || submission.jobId;
  if (!conversationId) throw new Error(`Missing conversation id for smoke case ${index + 1}`);
  const finalJob = jobId ? await waitForJob(clientId, jobId) : submission;
  const reportPayload = await waitForReport(clientId, conversationId);
  const report = reportPayload.report;
  if (!report) throw new Error(`Missing report for conversation ${conversationId}`);
  const casePath = path.join(caseDir, `${reportPayload.caseId}.json`);
  const artifactPaths = (report.documentControl?.schemaRefs || []).map((item) => path.join(artifactDir, `${item.artifactId}.json`));
  const row = {
    caseNumber: index + 1,
    clientId,
    conversationId,
    caseId: reportPayload.caseId,
    jobStatus: finalJob.job?.status || submission.job?.status || "unknown",
    artifactCount: report.documentControl?.artifactCount || 0,
    reportPath: report.indexing?.jsonPath,
    reportExists: Boolean(report.indexing?.jsonPath && fs.existsSync(report.indexing.jsonPath)),
    caseFileExists: fs.existsSync(casePath),
    artifactFilesExist: artifactPaths.every((entry) => fs.existsSync(entry)),
    folderExists: Boolean(report.indexing?.folderPath && fs.existsSync(path.join(reportDir, report.indexing.folderPath))),
    title: report.title,
    summary: report.interaction?.message || report.rootCause?.statement || "",
  };
  if (!row.reportExists || !row.caseFileExists || !row.artifactFilesExist || row.artifactCount < 1) {
    throw new Error(`Smoke case ${index + 1} did not persist the expected report package`);
  }
  results.push(row);
}

const after = {
  cases: countFiles(caseDir),
  artifacts: countFiles(artifactDir),
  reports: countFiles(reportDir, "troubleshooting-report.json"),
};
const summary = { baseUrl, generatedAt: new Date().toISOString(), before, after, delta: { cases: after.cases - before.cases, artifacts: after.artifacts - before.artifacts, reports: after.reports - before.reports }, results };
const outputPath = path.join(outputDir, `cateo-troubleshooting-smoke-${stamp}.json`);
fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ outputPath, delta: summary.delta, results: results.map((item) => ({ caseNumber: item.caseNumber, caseId: item.caseId, artifactCount: item.artifactCount, reportPath: item.reportPath })) }, null, 2));
