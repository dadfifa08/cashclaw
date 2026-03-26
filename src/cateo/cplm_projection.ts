import type {
  CateoApplicabilityEffectivity,
  CateoArtifactEnterpriseMetadata,
  CateoArtifactRelation,
  CateoChangeHistoryEntry,
  CateoConfigurationFingerprint,
  CateoExternalSystemLinks,
} from "./types.js";

export interface CateoProjectedObjectMetadata {
  category?: string;
  categoryLabel?: string;
  persistentObjectId?: string;
  lifecycleState?: string;
  documentType?: string;
  controlledVocabulary?: string[];
}

export interface CateoProjectedEffectivityRule {
  ruleId?: string;
  serialRanges?: string[];
  softwareVersions?: string[];
  geographies?: string[];
  notes?: string[];
}

export interface CateoProjectedRelationship {
  relationType: string;
  targetId: string;
  targetLabel?: string;
  targetType?: string;
}

export interface CateoProjectedChangeHistoryItem {
  changeId?: string;
  timestamp?: string;
  actor?: string;
  summary: string;
  fromState?: string;
  toState?: string;
  source?: string;
}

export interface CateoProjectedConfigurationFingerprint {
  fingerprintId?: string;
  serialNumber?: string;
  softwareVersions?: string[];
  geography?: string;
  assetId?: string;
  summary?: string;
  hash?: string;
}

export interface CateoProjectedExternalSystemLink {
  system: string;
  externalId: string;
  recordHint?: string;
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function uniqueObjects<T>(values: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function mapSystemLabel(system: keyof CateoExternalSystemLinks): string {
  if (system === "cmsIds") return "CMS";
  if (system === "n7Ids") return "N7";
  if (system === "crmIds") return "CRM";
  return "ERP";
}

function pickConfigValue(configuration: Record<string, string> | undefined, tokens: string[]): string | undefined {
  if (!configuration) return undefined;
  const match = Object.entries(configuration).find(([key]) => tokens.some((token) => key.toLowerCase().includes(token)));
  return match?.[1];
}

function pickConfigValues(configuration: Record<string, string> | undefined, tokens: string[]): string[] {
  if (!configuration) return [];
  return unique(Object.entries(configuration)
    .filter(([key]) => tokens.some((token) => key.toLowerCase().includes(token)))
    .map(([, value]) => value));
}

function matchRefs(values: string[] | undefined, tokens: string[]): string[] {
  return unique((values ?? []).filter((value) => tokens.some((token) => value.toLowerCase().includes(token))));
}

function confidenceToScore(confidence: string | undefined): number | undefined {
  if (confidence === "high") return 0.92;
  if (confidence === "medium") return 0.68;
  if (confidence === "low") return 0.38;
  return undefined;
}

function pruneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => pruneValue(entry))
      .filter((entry) => {
        if (entry === undefined || entry === null) return false;
        if (Array.isArray(entry)) return entry.length > 0;
        if (typeof entry === "object") return Object.keys(entry as Record<string, unknown>).length > 0;
        if (typeof entry === "string") return entry.trim().length > 0;
        return true;
      });
    return next.length > 0 ? next : undefined;
  }
  if (value && typeof value === "object") {
    const next = Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, pruneValue(entry)])
      .filter(([, entry]) => {
        if (entry === undefined || entry === null) return false;
        if (Array.isArray(entry)) return entry.length > 0;
        if (typeof entry === "object") return Object.keys(entry as Record<string, unknown>).length > 0;
        if (typeof entry === "string") return entry.trim().length > 0;
        return true;
      }));
    return Object.keys(next).length > 0 ? next : undefined;
  }
  if (typeof value === "string") {
    return value.trim() ? value : undefined;
  }
  return value;
}

function upstreamDependencies(relations: CateoArtifactRelation[] | undefined): string[] {
  return unique((relations ?? [])
    .filter((relation) => relation.kind === "depends-on" || relation.kind === "has-parent" || relation.kind === "belongs-to-component")
    .map((relation) => relation.label || relation.targetId));
}

function downstreamDependencies(relations: CateoArtifactRelation[] | undefined): string[] {
  return unique((relations ?? [])
    .filter((relation) => relation.kind === "has-child" || relation.kind === "documents" || relation.kind === "documented-in")
    .map((relation) => relation.label || relation.targetId));
}

function lastServiceAgo(lastServiceAt: string | undefined): string | undefined {
  if (!lastServiceAt) return undefined;
  const delta = Date.now() - new Date(lastServiceAt).getTime();
  if (!Number.isFinite(delta) || delta < 0) return undefined;
  const days = Math.round(delta / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function toProjectedObjectMetadata(metadata: CateoArtifactEnterpriseMetadata | undefined): CateoProjectedObjectMetadata | undefined {
  if (!metadata) return undefined;
  return pruneValue({
    category: metadata.objectMetadata?.objectCategory,
    categoryLabel: metadata.objectMetadata?.objectCategory,
    persistentObjectId: metadata.objectMetadata?.persistentObjectId,
    lifecycleState: metadata.lifecycleState,
    documentType: metadata.documentType,
    controlledVocabulary: unique([
      metadata.taxonomy?.domain,
      metadata.taxonomy?.discipline,
      metadata.taxonomy?.subsystem,
      metadata.classification?.failureCode,
      metadata.classification?.failureMode,
    ]),
  }) as CateoProjectedObjectMetadata | undefined;
}

export function toProjectedEffectivityRules(effectivity: CateoApplicabilityEffectivity | undefined): CateoProjectedEffectivityRule[] {
  if (!effectivity) return [];
  return pruneValue([{
    ruleId: effectivity.assetIds?.[0],
    serialRanges: effectivity.serialRanges?.map((range) => [range.serialStart, range.serialEnd].filter(Boolean).join(" -> ")),
    softwareVersions: effectivity.softwareVersions?.map((range) => [range.product, range.minVersion && `>= ${range.minVersion}`, range.maxVersion && `<= ${range.maxVersion}`].filter(Boolean).join(" ")),
    geographies: effectivity.geographies,
    notes: unique([...(effectivity.applicabilityNotes ?? []), ...(effectivity.locationPaths ?? [])]),
  }]) as CateoProjectedEffectivityRule[];
}

export function toProjectedRelationships(relations: CateoArtifactRelation[] | undefined): CateoProjectedRelationship[] {
  return uniqueObjects((relations ?? []).map((relation) => ({
    relationType: relation.kind.replace(/-/g, "_"),
    targetId: relation.targetId,
    targetLabel: relation.label,
    targetType: relation.targetType,
  })));
}

export function toProjectedChangeHistory(changeHistory: CateoChangeHistoryEntry[] | undefined): CateoProjectedChangeHistoryItem[] {
  return uniqueObjects((changeHistory ?? []).map((entry) => ({
    changeId: entry.changeId,
    timestamp: entry.changedAt,
    actor: entry.actor,
    summary: entry.summary,
    source: entry.action,
  })));
}

export function toProjectedConfigurationFingerprint(metadata: CateoArtifactEnterpriseMetadata | undefined): CateoProjectedConfigurationFingerprint | undefined {
  const fingerprint: CateoConfigurationFingerprint | undefined = metadata?.configurationFingerprint;
  if (!fingerprint && !metadata?.asset?.configuration && !metadata?.asset?.serialNumber) return undefined;
  const configuration = metadata?.asset?.configuration ?? {};
  const softwareVersions = unique([
    pickConfigValue(configuration, ["software", "recipe", "version"]),
    pickConfigValue(configuration, ["firmware"]),
  ]);
  return pruneValue({
    fingerprintId: fingerprint?.fingerprint,
    serialNumber: metadata?.asset?.serialNumber,
    softwareVersions,
    geography: metadata?.effectivity?.geographies?.[0],
    assetId: metadata?.asset?.assetId,
    summary: unique([
      metadata?.asset?.assetType,
      metadata?.asset?.model,
      metadata?.asset?.serialNumber ? `Serial ${metadata.asset.serialNumber}` : undefined,
      softwareVersions.length > 0 ? `Software ${softwareVersions.join(", ")}` : undefined,
    ]).join(" | "),
    hash: fingerprint?.fingerprint,
  }) as CateoProjectedConfigurationFingerprint | undefined;
}

export function toProjectedExternalSystemLinks(externalSystemIds: CateoExternalSystemLinks | undefined): CateoProjectedExternalSystemLink[] {
  if (!externalSystemIds) return [];
  const items: CateoProjectedExternalSystemLink[] = [];
  for (const [system, values] of Object.entries(externalSystemIds) as Array<[keyof CateoExternalSystemLinks, string[]]>) {
    for (const value of values ?? []) {
      items.push({ system: mapSystemLabel(system), externalId: value, recordHint: system });
    }
  }
  return uniqueObjects(items);
}

export function deriveDeepMetadataFromArtifactMetadata(metadata: CateoArtifactEnterpriseMetadata | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  if (metadata.deepMetadata && Object.keys(metadata.deepMetadata).length > 0) {
    return metadata.deepMetadata;
  }

  const configuration = metadata.asset?.configuration ?? {};
  const relatedArtifacts = (metadata.relations ?? [])
    .filter((relation) => relation.targetType === "artifact")
    .map((relation) => relation.label || relation.targetId);
  const deepMetadata = {
    partIdentity: {
      partNumber: metadata.parts?.primaryPartNumber ?? metadata.partNumber,
      revisionDrawingRev: pickConfigValue(configuration, ["drawing", "revision", "rev"]),
      description: metadata.parts?.primaryPartDescription ?? metadata.partDescription,
      assemblyLevel: metadata.objectMetadata?.objectCategory,
      parentAssembly: upstreamDependencies(metadata.relations)[0],
      childComponents: unique([...(metadata.parts?.requiredPartLines ?? []).map((line) => line.partNumber), ...downstreamDependencies(metadata.relations)]),
      bomPositionItemNumber: unique([metadata.objectMetadata?.bomNodeId, ...(metadata.parts?.billOfMaterialsRefs ?? [])]).join(" | "),
      manufacturer: metadata.asset?.manufacturer,
      supplierVendor: pickConfigValue(configuration, ["supplier", "vendor"]),
      alternatePartNumbers: unique([...(metadata.parts?.interchangeablePartNumbers ?? []), ...(metadata.parts?.candidateSkus ?? [])]),
      serialNumber: metadata.asset?.serialNumber,
      lotBatchNumber: pickConfigValue(configuration, ["lot", "batch"]),
    },
    productConfiguration: {
      productFamily: metadata.taxonomy?.subsystem,
      platform: metadata.businessType,
      model: metadata.asset?.model,
      variantOptionPackage: pickConfigValue(configuration, ["variant", "option", "package"]),
      firmwareVersion: pickConfigValue(configuration, ["firmware"]),
      softwareVersion: pickConfigValue(configuration, ["software", "recipe", "version"]),
      hardwareRevision: pickConfigValue(configuration, ["hardware", "board", "revision", "rev"]),
      regionMarketVersion: metadata.effectivity?.geographies?.[0],
      installedAccessories: pickConfigValues(configuration, ["accessory", "kit", "option"]),
      compatibleSystemsInterfaces: unique([metadata.asset?.assetType, metadata.asset?.model, ...metadata.effectivity?.assetIds ?? []]),
    },
    lifecycleAndOwnership: {
      buildDate: pickConfigValue(configuration, ["build", "manufactur"]),
      installDate: pickConfigValue(configuration, ["install"]),
      commissionDate: pickConfigValue(configuration, ["commission"]),
      warrantyStatus: pickConfigValue(configuration, ["warranty"]),
      serviceContractType: pickConfigValue(configuration, ["contract", "service_plan"]),
      endOfLifeObsolescenceStatus: metadata.lifecycleState === "obsolete" || metadata.lifecycleState === "superseded" ? metadata.lifecycleState : undefined,
      assetOwner: metadata.asset?.assetId,
      siteLocation: metadata.asset?.locationHierarchy?.[0],
      departmentLineCell: metadata.asset?.locationHierarchy?.slice(1),
      custodianTechnicianAssigned: metadata.workOrder?.title,
    },
    functionalContext: {
      functionOfThePartInTheSystem: metadata.componentTitle,
      criticalityRanking: metadata.riskLevel,
      safetyCritical: metadata.riskLevel === "critical" || metadata.taxonomy?.domain === "inspection",
      qualityCritical: metadata.taskClass === "inspection" || metadata.taskClass === "root-cause-analysis",
      regulatoryImpact: metadata.documentControl?.regulatoryContexts,
      failureImpactCategory: metadata.classification?.riskStatement,
      upstreamDependencies: upstreamDependencies(metadata.relations),
      downstreamDependencies: downstreamDependencies(metadata.relations),
      requiredToolsFixturesCalibrationDevices: metadata.actions?.requiredTools,
    },
    operatingEnvironment: {
      temperatureRange: pickConfigValue(configuration, ["temp", "temperature"]),
      humidityRange: pickConfigValue(configuration, ["humidity"]),
      vibrationShockExposure: unique([pickConfigValue(configuration, ["vibration", "shock"]), ...metadata.media?.analysisSignals?.filter((entry) => /vibration|shock/i.test(entry)) ?? []]),
      cleanroomDustCorrosiveEnvironment: unique([metadata.taxonomy?.environment, ...metadata.media?.analysisSignals?.filter((entry) => /cleanroom|dust|corros/i.test(entry)) ?? []]),
      dutyCycle: pickConfigValue(configuration, ["duty", "cycle"]),
      loadPressureSpeedVoltageContext: unique([pickConfigValue(configuration, ["load"]), pickConfigValue(configuration, ["pressure"]), pickConfigValue(configuration, ["speed"]), pickConfigValue(configuration, ["voltage"])]),
      shiftPatternRuntimeHours: unique([pickConfigValue(configuration, ["shift"]), metadata.asset?.configuration?.operatingHours]),
      storageConditions: pickConfigValue(configuration, ["storage"]),
    },
    conditionAndSymptomCapture: {
      conditionStatus: metadata.taxonomy?.operatingState,
      visualCondition: metadata.media?.analysisSignals?.filter((entry) => /visual|visible|marking|scratch|crack/i.test(entry)),
      wearState: metadata.classification?.symptomSummary?.filter((entry) => /wear|erosion|fatigue/i.test(entry)),
      damageType: metadata.classification?.symptomSummary?.filter((entry) => /damage|crack|burn|deform|leak/i.test(entry)),
      contaminationStatus: metadata.classification?.symptomSummary?.filter((entry) => /contamin|debris|residue/i.test(entry)),
      noiseVibrationHeatObservations: metadata.classification?.symptomSummary?.filter((entry) => /noise|vibration|heat|hot/i.test(entry)),
      errorCodeAlarmCode: unique([metadata.classification?.failureCode, metadata.classification?.failureLabel]),
      faultFrequency: metadata.maintenance?.serviceHistorySummaries?.length ? `Observed across ${metadata.maintenance.serviceHistorySummaries.length} service events` : undefined,
      intermittentVsConstant: metadata.taxonomy?.operatingState,
      onsetTimestamp: metadata.maintenance?.lastServiceAt,
      triggerConditions: metadata.classification?.symptomSummary?.filter((entry) => /when|after|during|under/i.test(entry)),
      reproducibility: metadata.classification?.symptomSummary?.find((entry) => /repeat|reproduc|intermittent|constant/i.test(entry)),
      severity: metadata.riskLevel,
      containmentStatus: metadata.actions?.followUpActions?.find((entry) => /contain|isolate|hold/i.test(entry)),
    },
    inspectionAndMeasurement: {
      inspectionType: metadata.taskClass,
      inspectionMethod: metadata.documentType,
      specificationToleranceReference: metadata.evidence?.measuredCriteria,
      measuredValues: metadata.media?.derivedMeasurements,
      units: unique((metadata.media?.derivedMeasurements ?? []).map((entry) => entry.split(" ").at(-1))),
      passFailResult: metadata.approvalState === "approved" ? "pass" : metadata.approvalState,
      deviationFromNominal: metadata.evidence?.measuredCriteria?.filter((entry) => /expected|tolerance|deviation/i.test(entry)),
      gaugeInstrumentUsed: metadata.actions?.requiredTools?.filter((entry) => /meter|gauge|indicator|calibr/i.test(entry)),
      calibrationStatusOfInstrument: metadata.actions?.requiredTools?.some((entry) => /calibr/i.test(entry)) ? "Calibration-sensitive tool referenced" : undefined,
      inspector: metadata.traceability?.userId || metadata.traceability?.requesterId || "cateo-ai",
      inspectionTimestamp: metadata.changeHistory?.[0]?.changedAt,
      evidenceAttachments: metadata.evidence?.attachmentNames,
      confidenceScore: confidenceToScore(metadata.confidence),
    },
    failureAnalysis: {
      suspectedFailureMode: metadata.classification?.failureMode,
      confirmedFailureMode: metadata.confidence === "high" ? metadata.classification?.failureMode : undefined,
      failureMechanism: metadata.taxonomy?.failureMechanism,
      rootCauseCategory: metadata.classification?.rootCause,
      contributingFactors: metadata.actions?.followUpActions,
      failureLocationOnPart: metadata.componentTitle,
      detectionMethod: metadata.documentType,
      verificationMethod: metadata.actions?.validationSteps,
      whyNowFactors: metadata.classification?.symptomSummary?.filter((entry) => /sudden|recent|after|during/i.test(entry)),
      similarKnownCases: metadata.analytics?.recurringSignals,
      recurrenceStatus: metadata.maintenance?.recurringFailureCodes?.length ? "repeat-observed" : undefined,
    },
    serviceAndMaintenanceHistory: {
      pmInterval: pickConfigValue(configuration, ["pm", "preventive", "interval"]),
      lastPmDate: metadata.maintenance?.lastServiceAt,
      lastRepairDate: metadata.maintenance?.lastServiceAt,
      serviceEventCount: metadata.evidence?.serviceHistoryCount,
      replacedBefore: (metadata.parts?.candidateSkus ?? []).length > 1,
      replacementFrequency: metadata.evidence?.serviceHistoryCount ? `Observed in ${metadata.evidence.serviceHistoryCount} prior service event(s)` : undefined,
      priorSymptoms: metadata.maintenance?.serviceHistorySummaries,
      priorCorrectiveActions: metadata.actions?.recommendedActions,
      priorPreventiveActions: metadata.actions?.followUpActions,
      timeSinceLastIntervention: lastServiceAgo(metadata.maintenance?.lastServiceAt),
      mtbfMttrIfAvailable: pickConfigValue(configuration, ["mtbf", "mttr"]),
    },
    processAndManufacturingContext: {
      manufacturingProcess: pickConfigValue(configuration, ["process", "manufactur"]),
      material: metadata.taxonomy?.failureMechanism,
      surfaceFinishCoating: pickConfigValue(configuration, ["finish", "coating"]),
      heatTreatment: pickConfigValue(configuration, ["heat"]),
      torqueFasteningSpec: pickConfigValue(configuration, ["torque", "fasten"]),
      adhesiveSealantUsed: pickConfigValue(configuration, ["adhesive", "sealant"]),
      assemblyProcessStep: pickConfigValue(configuration, ["assembly", "step"]),
      supplierProcessLine: pickConfigValue(configuration, ["supplier", "line"]),
      inspectionGateInManufacturing: pickConfigValue(configuration, ["inspection", "gate"]),
      nonconformanceHistory: matchRefs(metadata.evidence?.documentRefs, ["ncr", "nc", "deviation"]),
    },
    businessAndOperationalImpact: {
      downtimeStarted: pickConfigValue(configuration, ["downtime", "outage"]),
      downtimeCostEstimate: pickConfigValue(configuration, ["cost"]),
      productionImpact: metadata.classification?.riskStatement,
      scrapYieldImpact: metadata.classification?.symptomSummary?.filter((entry) => /scrap|yield/i.test(entry)),
      customerImpact: metadata.classification?.riskStatement,
      urgency: metadata.workOrder?.priority || metadata.riskLevel,
      escalationLevel: metadata.governance?.ruleEscalationCount,
      replacementAvailability: pickConfigValue(configuration, ["availability"]),
      leadTime: pickConfigValue(configuration, ["lead", "time"]),
      inventoryOnHand: pickConfigValue(configuration, ["inventory", "stock"]),
      approvedSubstitutes: metadata.parts?.interchangeablePartNumbers,
    },
    knowledgeAndArtifactLinkage: {
      relatedSop: matchRefs(metadata.evidence?.documentRefs, ["sop"]),
      relatedWorkInstruction: matchRefs(metadata.evidence?.documentRefs, ["work instruction", "wi"]),
      relatedTroubleshootingGuide: unique([metadata.traceability?.caseId]),
      relatedDrawingCadModel: matchRefs(metadata.evidence?.documentRefs, ["drawing", "cad", "model"]),
      relatedNcrCapaDeviation: matchRefs(metadata.evidence?.documentRefs, ["ncr", "capa", "deviation"]),
      relatedServiceBulletin: matchRefs(metadata.evidence?.documentRefs, ["bulletin"]),
      relatedTrainingModule: matchRefs(metadata.evidence?.documentRefs, ["training"]),
      relatedPreviousCateoArtifact: relatedArtifacts,
      lessonsLearnedTag: unique([...(metadata.actions?.followUpActions ?? []).slice(0, 6), ...(metadata.analytics?.recurringSignals ?? []).slice(0, 6)]),
    },
  } satisfies Record<string, unknown>;

  return pruneValue(deepMetadata) as Record<string, unknown> | undefined;
}

function mergeValue(existing: unknown, incoming: unknown): unknown {
  if (incoming === undefined || incoming === null || incoming === "") return existing;
  if (existing === undefined || existing === null || existing === "") return incoming;
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return uniqueObjects([...existing, ...incoming]);
  }
  if (existing && incoming && typeof existing === "object" && typeof incoming === "object" && !Array.isArray(existing) && !Array.isArray(incoming)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(existing as Record<string, unknown>), ...Object.keys(incoming as Record<string, unknown>)])) {
      result[key] = mergeValue((existing as Record<string, unknown>)[key], (incoming as Record<string, unknown>)[key]);
    }
    return result;
  }
  return existing ?? incoming;
}

export function mergeProjectedDeepMetadata(existing: Record<string, unknown> | undefined, incoming: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!existing) return incoming ? structuredClone(incoming) : undefined;
  if (!incoming) return existing;
  return mergeValue(existing, incoming) as Record<string, unknown>;
}
