import type { CateoRuntimeModelInfo } from "../llm/runtime.js";

export type CateoArtifactType =
  | "troubleshooting-procedure"
  | "inspection-checklist"
  | "service-report"
  | "parts-tools-list"
  | "diagnostic-reasoning-log";

export type CateoTaskClass =
  | "inspection"
  | "troubleshooting"
  | "preventive-maintenance"
  | "root-cause-analysis"
  | "documentation"
  | "mixed";


export type CateoProductOffering =
  | "troubleshooting-guide"
  | "preventive-maintenance-report"
  | "deviation-investigation-report"
  | "audit-ready-documentation-package"
  | "work-instructions-sop"
  | "validation-qualification-protocol"
  | "predictive-failure-analysis"
  | "fmea"
  | "cost-impact-downtime-report"
  | "parts-inventory-optimization"
  | "digital-twin-comparison-report"
  | "camera-based-diagnostic-report";
export const CATEO_BUSINESS_TYPES = [
  "medical-devices",
  "clinical-diagnostics",
  "pharmaceutical-manufacturing",
  "biotech-lifesciences",
  "research-laboratory",
  "aerospace-defense",
  "automotive",
  "industrial-manufacturing",
  "semiconductor",
  "electronics",
  "energy-utilities",
  "oil-gas",
  "chemical-processing",
  "food-beverage",
  "water-wastewater",
  "building-automation",
  "transportation-logistics",
  "telecommunications",
  "information-technology",
  "software-systems",
  "general-engineering",
] as const;
export type CateoBusinessType = typeof CATEO_BUSINESS_TYPES[number];
export type CateoSkillExposure = "public" | "cashclaw" | "both";

export type CateoApprovalState = "draft" | "reviewed" | "approved";
export type CateoConfidence = "low" | "medium" | "high";
export type CateoRiskLevel = "low" | "medium" | "high" | "critical";
export type CateoAttachmentKind = "image" | "video" | "document";
export type CateoResponseDetail = "concise" | "balanced" | "detailed";
export type CateoObjectCategory =
  | "assembly"
  | "sub-assembly"
  | "part"
  | "consumable"
  | "ln"
  | "software"
  | "tool"
  | "document"
  | "knowledge-asset"
  | "other";
export type CateoDocumentType =
  | "manual"
  | "procedure"
  | "drawing"
  | "training-material"
  | "report"
  | "checklist"
  | "parts-list"
  | "datasheet"
  | "specification"
  | "knowledge-asset"
  | "other";
export type CateoLifecycleState = "draft" | "released" | "obsolete" | "superseded";

export interface CateoExternalSystemLinks {
  cmsIds: string[];
  n7Ids: string[];
  crmIds: string[];
  erpIds: string[];
}

export interface CateoEffectivitySerialRange {
  serialStart?: string;
  serialEnd?: string;
  note?: string;
}

export interface CateoEffectivitySoftwareRange {
  product?: string;
  minVersion?: string;
  maxVersion?: string;
  note?: string;
}

export interface CateoApplicabilityEffectivity {
  serialRanges: CateoEffectivitySerialRange[];
  softwareVersions: CateoEffectivitySoftwareRange[];
  geographies: string[];
  locationPaths: string[];
  assetIds: string[];
  applicabilityNotes: string[];
}

export interface CateoObjectMetadata {
  persistentObjectId: string;
  masterRecordId: string;
  objectCategory: CateoObjectCategory;
  bomNodeId?: string;
  hierarchyPath: string[];
  parentObjectIds: string[];
  childObjectIds: string[];
  lineNumberRef?: string;
}

export interface CateoConfigurationFingerprint {
  fingerprint: string;
  source: string[];
}

export interface CateoChangeHistoryEntry {
  changeId: string;
  changedAt: string;
  actor: string;
  action: string;
  summary: string;
  relatedCaseId?: string;
  relatedArtifactId?: string;
  revisionId?: string;
  revisionNumber?: number;
  note?: string;
}

export interface CateoSkillActivation {
  id: string;
  title: string;
  category: string;
  summary: string;
  reason: string;
  exposure: CateoSkillExposure;
  recommendedArtifacts: CateoArtifactType[];
  recommendedTools: string[];
  datasetTags: string[];
}

export interface CateoAdapterCapability {
  id: string;
  title: string;
  category: string;
  status: "detected" | "available" | "planned";
  summary: string;
  notes: string[];
  command?: string;
  envVar?: string;
  upstream?: string;
}

export interface CateoAttachmentCalibration {
  referenceName?: string;
  pixels: number;
  actualLength: number;
  unit: string;
}

export interface CateoAttachmentDimensionAnnotation {
  name: string;
  expected: number;
  unit: string;
  observedPixels?: number;
  startPx?: number[];
  endPx?: number[];
  tolerancePct?: number;
  toleranceAbs?: number;
}

export interface CateoAttachmentPointAnnotation {
  name: string;
  observed: number[];
  expected: number[];
  unit: string;
  toleranceAbs: number;
}

export interface CateoAttachmentAnnotations {
  referenceModelId?: string;
  expectedStateLabel?: string;
  calibration?: CateoAttachmentCalibration;
  dimensions?: CateoAttachmentDimensionAnnotation[];
  points?: CateoAttachmentPointAnnotation[];
}

export interface CateoAttachmentInput {
  kind: CateoAttachmentKind;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  note?: string;
  contentBase64?: string;
  annotations?: CateoAttachmentAnnotations;
}

export interface CateoMachineMetadata {
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  configuration?: Record<string, string>;
  locationHierarchy?: string[];
  operatingHours?: number;
  environment?: string;
  geography?: string;
  externalSystemIds?: CateoExternalSystemLinks;
}

export interface CateoAssetRegistryLink {
  assetId: string;
  assetType?: string;
  model?: string;
  configuration?: Record<string, string>;
  locationHierarchy?: string[];
  geography?: string;
  externalSystemIds?: CateoExternalSystemLinks;
}

export interface CateoWorkOrderLink {
  workOrderId: string;
  title?: string;
  priority?: "low" | "medium" | "high" | "critical";
  status?: string;
  productOffering?: CateoProductOffering;
  partNumber?: string;
  contextNotes?: string;
  externalSystemIds?: CateoExternalSystemLinks;
}

export interface CateoServiceHistoryEntry {
  occurredAt: string;
  workOrderId?: string;
  summary: string;
  actionTaken?: string;
  failureCode?: string;
  partSkus?: string[];
}

export interface CateoFailureCodeEntry {
  code: string;
  label: string;
  description?: string;
}

export interface CateoTaxonomyBundle {
  failureCodes?: CateoFailureCodeEntry[];
  locationHierarchy?: string[];
  assetIds?: string[];
}

export interface CateoPartCatalogEntry {
  sku: string;
  description: string;
  compatibleModels?: string[];
  quantitySuggested?: number;
  storageLocation?: string;
}

export type CateoWorkflowMode = "chat" | "reviewed-document";
export type CateoRiskTier = "low" | "medium" | "high" | "critical";

export interface CateoWorkflowIntake {
  mode?: CateoWorkflowMode;
  requestedBy?: string;
  documentIntent?: string;
  businessJustification?: string;
  drjJustification?: string;
  complianceScope?: string[];
  riskTier?: CateoRiskTier;
  requiresAdminRelease?: boolean;
}

export interface CateoVerifiedSource {
  title: string;
  url: string;
  domain?: string;
  reason?: string;
  documentType?: string;
  publisherType?: string;
  summary?: string;
}

export interface CateoPartResolution {
  partNumber?: string;
  partDescription?: string;
  manufacturer?: string;
  confidencePct: number;
  needsClarification: boolean;
  clarifyingQuestion?: string;
  evidence: string[];
  aliases: string[];
  searchQueries: string[];
  failureModes: string[];
  preventiveMaintenanceHints: string[];
  hazardSignals: string[];
  expectedValues: string[];
  groundedFindings: string[];
  referenceDocuments: string[];
  verifiedSources: CateoVerifiedSource[];
}

export interface CateoDimensionObservation {
  name: string;
  expected: number;
  observed: number;
  unit: string;
  tolerancePct?: number;
  toleranceAbs?: number;
}

export interface CateoPointObservation {
  name: string;
  expected: number[];
  observed: number[];
  unit: string;
  toleranceAbs: number;
}

export interface CateoDigitalTwinInput {
  referenceModelId?: string;
  expectedStateLabel?: string;
  dimensions?: CateoDimensionObservation[];
  points?: CateoPointObservation[];
}

export interface CateoAttachmentEvidence {
  attachmentId: string;
  kind: CateoAttachmentKind;
  name: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  storageRef: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  codec?: string;
  referenceModelId?: string;
  expectedStateLabel?: string;
  derivedDimensions: CateoDimensionObservation[];
  derivedPoints: CateoPointObservation[];
  notes: string[];
}

export interface CateoAssistInput {
  title?: string;
  query?: string;
  errorCode?: string;
  issueType?: string;
  businessType?: CateoBusinessType;
  productOffering?: CateoProductOffering;
  partNumber?: string;
  contextNotes?: string;
  responseDetail?: CateoResponseDetail;
  workflow?: CateoWorkflowIntake;
  symptomDescription: string;
  observedConditions?: string[];
  asset?: CateoAssetRegistryLink;
  machine?: CateoMachineMetadata;
  workOrder?: CateoWorkOrderLink;
  serviceHistory?: CateoServiceHistoryEntry[];
  taxonomy?: CateoTaxonomyBundle;
  partsCatalog?: CateoPartCatalogEntry[];
  attachments?: CateoAttachmentInput[];
  digitalTwin?: CateoDigitalTwinInput;
  requestedArtifacts?: CateoArtifactType[];
  instructionTemplate?: {
    templateId?: string;
    version?: string;
    taskClass?: CateoTaskClass;
  };
}

export interface CateoDigitalTwinDimensionResult {
  name: string;
  expected: number;
  observed: number;
  unit: string;
  deviationAbs: number;
  deviationPct: number;
  toleranceAbs: number;
  pass: boolean;
}

export interface CateoDigitalTwinPointResult {
  name: string;
  unit: string;
  distance: number;
  toleranceAbs: number;
  pass: boolean;
}

export interface CateoDigitalTwinResult {
  referenceModelId?: string;
  expectedStateLabel?: string;
  status: "pass" | "fail" | "not-run";
  reconstructedEnvelope?: {
    axisCount: number;
    span: number[];
    centroidShift: number[];
  };
  dimensionChecks: CateoDigitalTwinDimensionResult[];
  pointChecks: CateoDigitalTwinPointResult[];
  flaggedFeatures: string[];
  notes: string[];
}

export interface CateoMatchedFailureCode {
  code: string;
  label: string;
  description?: string;
}

export interface CateoContextBundle {
  caseId: string;
  title: string;
  taskClass: CateoTaskClass;
  issueType?: string;
  businessType?: CateoBusinessType;
  asset: CateoAssetRegistryLink | null;
  machine: CateoMachineMetadata | null;
  workOrder: CateoWorkOrderLink | null;
  failureCode: CateoMatchedFailureCode | null;
  partResolution: CateoPartResolution | null;
  observedConditions: string[];
  serviceHistory: CateoServiceHistoryEntry[];
  suggestedParts: CateoPartCatalogEntry[];
  attachments: CateoAttachmentEvidence[];
  taxonomy: CateoTaxonomyBundle;
  digitalTwin: CateoDigitalTwinResult | null;
  contextSummary: string[];
}

export interface TroubleshootingProcedureStep {
  id: string;
  action: string;
  rationale: string;
  expectedResult: string;
  escalationTrigger?: string;
}

export interface CateoTroubleshootingProcedure {
  title: string;
  objective: string;
  failureCode?: string;
  symptoms: string[];
  assumptions: string[];
  evidenceSummary: string[];
  safetyPrecautions: string[];
  requiredParts: string[];
  requiredTools: string[];
  steps: TroubleshootingProcedureStep[];
  acceptanceCriteria: string[];
  followUpActions: string[];
}

export interface InspectionChecklistItem {
  id: string;
  check: string;
  method: string;
  passCriteria: string;
  evidenceRequired: string;
  severityIfFailed: "low" | "medium" | "high" | "critical";
}

export interface CateoInspectionChecklist {
  title: string;
  scope: string;
  prepSteps: string[];
  safetyNotes: string[];
  checklist: InspectionChecklistItem[];
  completionCriteria: string[];
}

export interface CateoServiceReport {
  title: string;
  summary: string;
  findings: string[];
  actionsPerformed: string[];
  unresolvedRisks: string[];
  recommendations: string[];
  signoffRequirement: string;
}

export interface CateoPartLine {
  sku: string;
  description: string;
  quantity: number;
  justification: string;
  storageLocation?: string;
}

export interface CateoToolLine {
  name: string;
  quantity: number;
  purpose: string;
}

export interface CateoPartsToolsList {
  title: string;
  parts: CateoPartLine[];
  tools: CateoToolLine[];
  consumables: string[];
}

export interface CateoHypothesisLine {
  name: string;
  status: "candidate" | "ruled-out" | "confirmed";
  evidenceFor: string[];
  evidenceAgainst: string[];
}

export interface CateoDiagnosticReasoningLog {
  title: string;
  problemStatement: string;
  hypotheses: CateoHypothesisLine[];
  assumptions: string[];
  evidenceRequests: string[];
  rootCauseStatement: string;
  confidence: CateoConfidence;
}

export type CateoArtifactContent =
  | CateoTroubleshootingProcedure
  | CateoInspectionChecklist
  | CateoServiceReport
  | CateoPartsToolsList
  | CateoDiagnosticReasoningLog;

export type CateoArtifactSchemaId =
  | "cateo.troubleshooting-procedure"
  | "cateo.inspection-checklist"
  | "cateo.service-report"
  | "cateo.parts-tools-list"
  | "cateo.diagnostic-reasoning-log";

export interface CateoArtifactSchemaRef {
  id: CateoArtifactSchemaId;
  version: string;
}

export type CateoArtifactDuplicateState = "canonical" | "duplicate" | "merged-source";
export type CateoArtifactRelationTarget = "artifact" | "asset" | "work-order" | "part" | "component" | "failure-mode" | "document" | "conversation" | "case" | "external-record" | "software-version" | "geography";
export type CateoArtifactRelationStrength = "exact" | "high" | "medium" | "low";
export type CateoArtifactRelationSource = "ingested" | "inferred" | "merged" | "operator";

export interface CateoPartReferenceLine {
  partNumber: string;
  description: string;
  quantity?: number;
  unitOfMeasure?: string;
  manufacturer?: string;
  partFamily?: string;
  bomNodeId?: string;
  interchangeablePartNumbers?: string[];
}

export interface CateoArtifactRelation {
  relationId: string;
  kind:
    | "references"
    | "duplicate-of"
    | "derived-from"
    | "installed-on"
    | "linked-to-work-order"
    | "requires-part"
    | "depends-on"
    | "documents"
    | "documented-in"
    | "tracks-failure-mode"
    | "belongs-to-component"
    | "has-parent"
    | "has-child"
    | "superseded-by"
    | "linked-to-conversation"
    | "linked-to-case"
    | "linked-to-external-record";
  targetType: CateoArtifactRelationTarget;
  targetId: string;
  label?: string;
  strength: CateoArtifactRelationStrength;
  source: CateoArtifactRelationSource;
  tags?: string[];
}

export interface CateoDocumentControlMetadata {
  recordClass: string;
  retentionClass: string;
  confidentiality: "internal" | "restricted" | "regulated";
  reviewCadenceDays?: number;
  ownerTeam?: string;
  approvalBoard?: string;
  electronicSignoffRequired: boolean;
  changeReason?: string;
  supersededByArtifactId?: string;
  relatedArtifactIds: string[];
  regulatoryContexts: string[];
}

export interface CateoArtifactEnterpriseMetadata {
  artifactTitle: string;
  artifactSummary: string;
  taskClass: CateoTaskClass;
  businessType?: CateoBusinessType;
  approvalState: CateoApprovalState;
  confidence: CateoConfidence;
  riskLevel: CateoRiskLevel;
  lifecycleState: CateoLifecycleState;
  documentType?: CateoDocumentType;
  objectMetadata: CateoObjectMetadata;
  taxonomyTags: string[];
  componentTitle?: string;
  partNumber?: string;
  partDescription?: string;
  sourceTemplateId?: string;
  sourceTemplateVersion?: string;
  taxonomy: {
    domain: "inspection" | "maintenance" | "reliability" | "troubleshooting" | "documentation" | "mixed";
    industry?: CateoBusinessType;
    subsystem?: string;
    componentPath: string[];
    locationPath: string[];
    discipline?: string;
    failureMechanism?: string;
    failureEffect?: string;
    operatingState?: string;
    environment?: string;
  };
  classification: {
    failureCode?: string;
    failureLabel?: string;
    failureMode?: string;
    symptomSummary: string[];
    rootCause?: string;
    riskStatement?: string;
  };
  asset: {
    assetId?: string;
    assetType?: string;
    manufacturer?: string;
    model?: string;
    serialNumber?: string;
    locationHierarchy: string[];
    configuration: Record<string, string>;
  };
  workOrder: {
    workOrderId?: string;
    title?: string;
    priority?: "low" | "medium" | "high" | "critical";
    status?: string;
  };
  parts: {
    primaryPartNumber?: string;
    primaryPartDescription?: string;
    candidateSkus: string[];
    requiredPartLines: CateoPartReferenceLine[];
    billOfMaterialsRefs: string[];
    interchangeablePartNumbers: string[];
  };
  evidence: {
    attachmentIds: string[];
    attachmentNames: string[];
    evidenceSummary: string[];
    serviceHistoryCount: number;
    documentRefs: string[];
    digitalTwinStatus?: CateoDigitalTwinResult["status"];
    measuredCriteria: string[];
  };
  maintenance: {
    lastServiceAt?: string;
    serviceHistorySummaries: string[];
    recurringFailureCodes: string[];
    recurringPartSkus: string[];
  };
  media: {
    attachmentKinds: CateoAttachmentKind[];
    imageCount: number;
    videoCount: number;
    documentCount: number;
    derivedMeasurements: string[];
    analysisSignals: string[];
  };
  actions: {
    recommendedActions: string[];
    validationSteps: string[];
    requiredParts: string[];
    requiredTools: string[];
    followUpActions: string[];
  };
  relations: CateoArtifactRelation[];
  effectivity: CateoApplicabilityEffectivity;
  configurationFingerprint?: CateoConfigurationFingerprint;
  externalSystemIds: CateoExternalSystemLinks;
  changeHistory: CateoChangeHistoryEntry[];
  traceability: {
    caseId: string;
    runId: string;
    profileId?: string;
    requesterId?: string;
    userId?: string;
    conversationId?: string;
    messageId?: string;
    promptFingerprint: string;
    evidenceFingerprint: string;
    requestId?: string;
  };
  analytics: {
    artifactKeywords: string[];
    recurringSignals: string[];
    estimatedRevisionCount: number;
  };
  governance: {
    schemaId: CateoArtifactSchemaId;
    schemaVersion: string;
    templateId?: string;
    templateVersion?: string;
    validationStatus: "validated" | "fallback" | "deterministic";
    ruleEscalationCount: number;
    retryCount: number;
    activeSkillIds: string[];
    activeAdapterIds: string[];
  };
  documentControl: CateoDocumentControlMetadata;
  marketplace?: {
    source: "cashclaw" | "cateo-public";
    taskId?: string;
    taskStatus?: string;
    clientAddress?: string;
    quotedPriceWei?: string;
    toolScope: string[];
    toolCalls: string[];
  };
}

export interface CateoArtifactProvenance {
  runId: string;
  requestId?: string;
  createdAt: string;
  createdBy: string;
  source: "cateo-v1";
  taskClass: CateoTaskClass;
  modelsUsed: CateoRuntimeModelInfo[];
  evidenceFingerprint: string;
  promptFingerprint?: string;
  profileId?: string;
  userId?: string;
  conversationId?: string;
  messageId?: string;
  templateId?: string;
  templateVersion?: string;
}

export interface CateoJsonDiffEntry {
  path: string;
  before: string;
  after: string;
}

export interface CateoElectronicSignoff {
  actor: string;
  role: string;
  meaning: string;
  state: CateoApprovalState;
  signedAt: string;
}

export type CateoReviewWorkflowStage = "technical-review" | "quality-review" | "released";
export type CateoTechnicalReviewStatus = "pending" | "approved" | "redlined";
export type CateoQualityReviewStatus = "pending" | "released";
export type CateoStoredReviewFileKind = "generated-word" | "generated-pdf" | "technical-redline";

export interface CateoStoredReviewFile {
  kind: CateoStoredReviewFileKind;
  fileName: string;
  relativePath: string;
  mimeType?: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface CateoTechnicalReviewRecord {
  status: CateoTechnicalReviewStatus;
  reviewerUserId?: string;
  reviewerDisplayName?: string;
  note?: string;
  decidedAt?: string;
  redlineFile?: CateoStoredReviewFile;
}

export interface CateoQualityReviewRecord {
  status: CateoQualityReviewStatus;
  reviewerUserId?: string;
  reviewerDisplayName?: string;
  note?: string;
  decidedAt?: string;
}

export interface CateoCaseReviewWorkflow {
  stage: CateoReviewWorkflowStage;
  packageFiles: {
    generatedWord?: CateoStoredReviewFile;
    generatedPdf?: CateoStoredReviewFile;
  };
  technical: CateoTechnicalReviewRecord;
  quality: CateoQualityReviewRecord;
}

export interface CateoArtifactRevision {
  revisionId: string;
  revisionNumber: number;
  approvalState: CateoApprovalState;
  createdAt: string;
  createdBy: string;
  note?: string;
  summary: string;
  diffFromPrevious: CateoJsonDiffEntry[];
  signoffs: CateoElectronicSignoff[];
  provenance: CateoArtifactProvenance;
  metadata?: CateoArtifactEnterpriseMetadata;
  content: CateoArtifactContent;
}

export interface CateoArtifactRecord {
  artifactId: string;
  artifactType: CateoArtifactType;
  schema: CateoArtifactSchemaRef;
  caseId: string;
  assetId?: string;
  workOrderId?: string;
  linkedConversationIds?: string[];
  canonicalArtifactId?: string;
  duplicateGroupId?: string;
  duplicateState?: CateoArtifactDuplicateState;
  supersededByArtifactId?: string;
  relatedArtifactIds?: string[];
  mergedSourceArtifactIds?: string[];
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
  revisions: CateoArtifactRevision[];
}

export interface CateoCaseRecord {
  caseId: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  input: CateoAssistInput;
  context: CateoContextBundle;
  artifacts: string[];
  interaction?: CateoInteractionProjection;
  requester?: CateoRequesterInfo;
  conversationId?: string;
  userId?: string;
  usage?: CateoUsageSummary;
  trace: CateoReasoningTrace;
  reviewWorkflow?: CateoCaseReviewWorkflow;
}

export interface CateoRoutingDecision {
  taskClass: CateoTaskClass;
  requestedArtifacts: CateoArtifactType[];
  useChallenger: boolean;
  useStructure: boolean;
  reasons: string[];
  activeSkillIds?: string[];
  capabilityTags?: string[];
}

export interface CateoLeadPlan {
  taskClass: CateoTaskClass;
  objective: string;
  evidencePlan: string[];
  assumptions: string[];
  risks: string[];
  decisionBasis: string[];
  artifactPriorities: CateoArtifactType[];
  maintenanceConsiderations: string[];
  partsConsiderations: string[];
}

export interface CateoChallengerCritique {
  alternateHypotheses: string[];
  blindSpots: string[];
  missingAssumptions: string[];
  evidenceGaps: string[];
  recommendedAdjustments: string[];
}

export interface CateoStructureBlueprintLine {
  artifactType: CateoArtifactType;
  title: string;
  sectionOrder: string[];
  qualityGates: string[];
  requiredEvidence: string[];
}

export interface CateoStructureBlueprint {
  artifactPlans: CateoStructureBlueprintLine[];
}

export interface CateoFinalSynthesis {
  executiveSummary: string;
  decision: CateoApprovalState;
  confidence: CateoConfidence;
  rootCauseStatement: string;
  nextActions: string[];
  operatorNotes: string[];
}

export interface CateoBuilderArtifactDraft {
  artifactType: CateoArtifactType;
  title: string;
  content: CateoArtifactContent;
  generationMode: "model" | "deterministic-fallback";
  validationErrors: string[];
  notes: string[];
}

export interface CateoBuilderPackage {
  packageSummary: string;
  artifactPlans: CateoStructureBlueprintLine[];
  artifactDrafts: CateoBuilderArtifactDraft[];
}

export interface CateoReviewerDecision {
  overallStatus: "pass" | "needs-revision";
  technicalAccuracy: "pass" | "needs-attention";
  completeness: "pass" | "needs-attention";
  compliance: "pass" | "needs-attention";
  findings: string[];
  approvedArtifactTypes: CateoArtifactType[];
  approvalState: CateoApprovalState;
  confidence: CateoConfidence;
  summary: string;
  requiredFollowUp: string[];
}

export type CateoCheckpointStage =
  | "accepted"
  | "planning"
  | "building"
  | "reviewing"
  | "persisting"
  | "rendering"
  | "completed"
  | "failed";

export type CateoCheckpointStatus = "running" | "completed" | "failed";

export interface CateoInteractionCheckpoint {
  checkpointId: string;
  stage: CateoCheckpointStage;
  status: CateoCheckpointStatus;
  label: string;
  summary: string;
  occurredAt: number;
  taskClass?: CateoTaskClass;
  confidence?: CateoConfidence;
  artifactTypes?: CateoArtifactType[];
  artifactCount?: number;
}

export type CateoServiceTier = "free" | "reviewed" | "enterprise";

export interface CateoRequesterInfo {
  requesterId: string;
  profileId?: string;
  userId?: string;
  conversationId?: string;
  messageId?: string;
  displayName?: string;
  organization?: string;
  emailHash?: string;
  serviceTier?: CateoServiceTier;
  requiresEngineerReview?: boolean;
}

export interface CateoStageUsage {
  stage: "planner" | "builder" | "reviewer";
  role: "lead" | "structure" | "challenger";
  model: CateoRuntimeModelInfo;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CateoUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  stages: CateoStageUsage[];
}

export interface CateoInstructionTemplate {
  templateId: string;
  version: string;
  taskClass: CateoTaskClass;
  responseBehavior: string[];
  terminology: string[];
  fieldExpectations: string[];
  outputConstraints: string[];
  requiredArtifacts: CateoArtifactType[];
  controlledRulesDocument?: {
    path: string;
    content: string;
  };
}

export interface CateoValidationAttempt {
  stage: "builder" | "reviewer";
  attempt: number;
  outcome: "success" | "retry" | "fallback";
  errors: string[];
}

export interface CateoRuleResult {
  ruleId: string;
  severity: "info" | "warn" | "error";
  outcome: "pass" | "flag" | "escalate";
  message: string;
  artifactType?: CateoArtifactType;
  details?: string[];
}

export interface CateoArtifactLookupCandidate {
  artifactId: string;
  artifactType: CateoArtifactType;
  caseId: string;
  assetId?: string;
  workOrderId?: string;
  score: number;
  basis: string[];
  revisionNumber: number;
  approvalState: CateoApprovalState;
  updatedAt: string;
}

export interface CateoArtifactPersistAction {
  artifactType: CateoArtifactType;
  action: "created" | "merged";
  artifactId: string;
  revisionNumber: number;
  matchedArtifactId?: string;
  matchScore?: number;
}
export type CateoInteractionReleaseStatus = "available" | "clarification-required" | "pending-engineer-review";
export type CateoInteractionSectionTone = "info" | "caution" | "success";

export interface CateoInteractionSection {
  sectionId: string;
  title: string;
  tone: CateoInteractionSectionTone;
  items: string[];
}

export interface CateoInteractionArtifactPreview {
  artifactId: string;
  artifactType: CateoArtifactType;
  title: string;
  summary: string;
  approvalState: CateoApprovalState;
  revisionNumber: number;
}

export interface CateoInteractionProjection {
  message: string;
  highlights: string[];
  nextActions: string[];
  confidence: CateoConfidence;
  artifactCount: number;
  artifactLabels: string[];
  conversationTitle?: string;
  detailLevel?: CateoResponseDetail;
  sections?: CateoInteractionSection[];
  artifactPreviews?: CateoInteractionArtifactPreview[];
  clarifyingQuestion?: string;
  releaseStatus: CateoInteractionReleaseStatus;
  requiresEngineerReview?: boolean;
  renderedAt: string;
  rendererVersion: string;
}

export interface CateoReasoningTrace {
  route: CateoRoutingDecision;
  template: CateoInstructionTemplate;
  partResolution?: CateoPartResolution;
  activeSkills?: CateoSkillActivation[];
  adapters?: CateoAdapterCapability[];
  validationAttempts: CateoValidationAttempt[];
  ruleResults: CateoRuleResult[];
  lookupCandidates: CateoArtifactLookupCandidate[];
  persistActions: CateoArtifactPersistAction[];
  prompts: {
    planner: string;
    builder: string;
    reviewer: string;
  };
  leadPlan: CateoLeadPlan;
  challengerCritique?: CateoChallengerCritique;
  structureBlueprint?: CateoStructureBlueprint;
  builderPackage?: CateoBuilderPackage;
  reviewerDecision?: CateoReviewerDecision;
  finalSynthesis: CateoFinalSynthesis;
  rawLeadPlan?: string;
  rawChallengerCritique?: string;
  rawStructureBlueprint?: string;
  rawBuilderPackage?: string;
  rawReviewerDecision?: string;
  rawFinalSynthesis?: string;
}

export interface CateoAssistResult {
  caseId: string;
  runId: string;
  summary: string;
  interaction: CateoInteractionProjection;
  checkpoints: CateoInteractionCheckpoint[];
  context: CateoContextBundle;
  requester?: CateoRequesterInfo;
  usage?: CateoUsageSummary;
  trace: CateoReasoningTrace;
  artifacts: CateoArtifactRecord[];
}

export type CateoProcedureFeedbackRating =
  | "helpful"
  | "needs-correction"
  | "missing-steps"
  | "wrong-part"
  | "other";

export type CateoProcedureFeedbackStatus = "pending-review" | "approved" | "rejected";

export interface CateoProcedureFeedbackDecision {
  actor: string;
  action: "approve" | "reject";
  note?: string;
  decidedAt: string;
  releasedRevisionRefs: Array<{
    artifactId: string;
    revisionId: string;
    revisionNumber: number;
  }>;
}

export interface CateoProcedureFeedbackRecord {
  feedbackId: string;
  conversationId: string;
  caseId: string;
  artifactIds: string[];
  requesterId?: string;
  profileId?: string;
  userId?: string;
  submittedAt: string;
  updatedAt: string;
  status: CateoProcedureFeedbackStatus;
  rating: CateoProcedureFeedbackRating;
  comments: string;
  businessType?: CateoBusinessType;
  systemName?: string;
  partNumber?: string;
  issueType?: string;
  feedbackTags: string[];
  adminDecision?: CateoProcedureFeedbackDecision;
}

export interface CateoRevisionRequest {
  artifactId: string;
  editor: string;
  note?: string;
  contentPatch?: Record<string, unknown>;
  fullContent?: CateoArtifactContent;
}

export interface CateoSignoffRequest {
  artifactId: string;
  actor: string;
  role: string;
  meaning: string;
  state: CateoApprovalState;
  note?: string;
}










