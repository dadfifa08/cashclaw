import path from "node:path";
import { getConfigDir } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import type { CateoArtifactRecord, CateoArtifactRelation, CateoCaseRecord, CateoProductOffering, CateoRiskTier, CateoTaskClass } from "./types.js";
import { deriveDeepMetadataFromArtifactMetadata, mergeProjectedDeepMetadata, toProjectedChangeHistory, toProjectedConfigurationFingerprint, toProjectedEffectivityRules, toProjectedExternalSystemLinks, toProjectedObjectMetadata, toProjectedRelationships } from "./cplm_projection.js";

const PART_MASTER_VERSION = "cateo-part-master-v2";

export interface CateoTaxonomyValuePoint {
  label: string;
  count: number;
  samples: string[];
}

export interface CateoControlledTaxonomySnapshot {
  version: string;
  updatedAt: string;
  dimensions: {
    domains: CateoTaxonomyValuePoint[];
    disciplines: CateoTaxonomyValuePoint[];
    subsystems: CateoTaxonomyValuePoint[];
    failureMechanisms: CateoTaxonomyValuePoint[];
    failureEffects: CateoTaxonomyValuePoint[];
    operatingStates: CateoTaxonomyValuePoint[];
    environments: CateoTaxonomyValuePoint[];
    componentPaths: CateoTaxonomyValuePoint[];
    locationPaths: CateoTaxonomyValuePoint[];
    failureCodes: CateoTaxonomyValuePoint[];
    productOfferings: CateoTaxonomyValuePoint[];
    taskClasses: CateoTaxonomyValuePoint[];
  };
}

export interface CateoPartMasterRecord {
  canonicalPartNumber: string;
  normalizedPartNumber: string;
  displayTitle: string;
  description?: string;
  manufacturer?: string;
  partFamily?: string;
  lifecycleState?: string;
  persistentObjectId?: string;
  entityTypes: string[];
  parentPartNumbers: string[];
  childPartNumbers: string[];
  assemblyPartNumbers: string[];
  componentPartNumbers: string[];
  materialClasses: string[];
  specificationRefs: string[];
  aliases: string[];
  interchangeablePartNumbers: string[];
  componentTitles: string[];
  taxonomyTags: string[];
  productOfferings: CateoProductOffering[];
  documentTypes?: string[];
  taskClasses: CateoTaskClass[];
  failureCodes: string[];
  failureModes: string[];
  organizations: string[];
  assetIds: string[];
  workOrderIds: string[];
  artifactIds: string[];
  caseIds: string[];
  relationTargets: string[];
  objectMetadata?: ReturnType<typeof toProjectedObjectMetadata>;
  effectivity?: ReturnType<typeof toProjectedEffectivityRules>;
  relationships?: ReturnType<typeof toProjectedRelationships>;
  bomEdges?: Array<{ parentPartNumber?: string; childPartNumber?: string; quantity?: number; effectivityLabel?: string }>;
  changeHistory?: ReturnType<typeof toProjectedChangeHistory>;
  configurationFingerprint?: ReturnType<typeof toProjectedConfigurationFingerprint>;
  externalSystemLinks?: ReturnType<typeof toProjectedExternalSystemLinks>;
  deepMetadata?: Record<string, unknown>;
  approvalStates: Record<string, number>;
  riskTiers: CateoRiskTier[];
  lastSeenAt: string;
  sourceEvidenceCount: number;
  duplicateArtifactCount: number;
  releasedArtifactCount: number;
  taxonomy: {
    domains: string[];
    disciplines: string[];
    subsystems: string[];
    failureMechanisms: string[];
    failureEffects: string[];
    operatingStates: string[];
    environments: string[];
    componentPaths: string[];
    locationPaths: string[];
  };
}

export interface CateoPartMasterSnapshot {
  version: string;
  updatedAt: string;
  stats: {
    partCount: number;
    manufacturerCount: number;
    duplicateArtifactCount: number;
    releasedArtifactCount: number;
    unresolvedPartCount: number;
  };
  parts: CateoPartMasterRecord[];
  taxonomy: CateoControlledTaxonomySnapshot;
}

export interface CateoPartMasterFilters {
  q?: string;
  manufacturer?: string;
  productOffering?: string;
  failureCode?: string;
  partNumber?: string;
}

function partMasterPath(): string {
  return path.join(getConfigDir(), "cateo", "db", "part_master.json");
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

function normalizePartNumber(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase().replace(/\s+/g, "");
}

function displayPartNumber(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function pushTaxonomy(map: Map<string, { count: number; samples: Set<string> }>, label: string | undefined | null, sample?: string | undefined | null): void {
  const normalized = label?.trim();
  if (!normalized) return;
  const current = map.get(normalized) ?? { count: 0, samples: new Set<string>() };
  current.count += 1;
  if (sample?.trim()) current.samples.add(sample.trim());
  map.set(normalized, current);
}

function toTaxonomyPoints(map: Map<string, { count: number; samples: Set<string> }>, limit = 24): CateoTaxonomyValuePoint[] {
  return [...map.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, value]) => ({
      label,
      count: value.count,
      samples: [...value.samples].sort().slice(0, 6),
    }));
}

function appendRelationTargets(targets: string[], relations: CateoArtifactRelation[] | undefined): string[] {
  if (!relations || relations.length === 0) return targets;
  return unique([
    ...targets,
    ...relations.map((relation) => `${relation.targetType}:${relation.targetId}`),
  ]);
}

function inferEntityTypes(input: { displayTitle?: string; description?: string; taxonomyTags?: string[]; componentTitle?: string; requiredPartCount?: number; relationTargets?: string[]; objectCategory?: string }): string[] {
  const haystack = [
    input.displayTitle,
    input.description,
    input.componentTitle,
    ...(input.taxonomyTags ?? []),
    ...(input.relationTargets ?? []),
  ].filter(Boolean).join(" ").toLowerCase();
  const entityTypes: string[] = input.objectCategory ? [input.objectCategory] : [];
  if (/assembly|subassembly|module|manifold|harness|kit/.test(haystack) || (input.requiredPartCount ?? 0) > 1) entityTypes.push("assembly");
  if (/component|sensor|board|valve|motor|pump|switch|connector/.test(haystack) || Boolean(input.componentTitle)) entityTypes.push("component");
  if (/material|alloy|polymer|resin|steel|aluminum|stainless|copper|ceramic|adhesive|lubricant/.test(haystack)) entityTypes.push("material");
  if (/consumable|filter|sealant|grease|oil|solvent/.test(haystack)) entityTypes.push("consumable");
  if (/software|firmware|configuration|recipe/.test(haystack)) entityTypes.push("software");
  return unique(entityTypes.length > 0 ? entityTypes : ["part"]);
}

function inferMaterialClasses(input: { description?: string; taxonomyTags?: string[]; displayTitle?: string }): string[] {
  const haystack = [input.displayTitle, input.description, ...(input.taxonomyTags ?? [])].filter(Boolean).join(" ").toLowerCase();
  const mappings = [
    ["stainless-steel", /stainless|316l|304/],
    ["aluminum", /aluminum|aluminium/],
    ["copper", /copper|brass|bronze/],
    ["polymer", /polymer|plastic|ptfe|peek|pvc|polyethylene|polypropylene/],
    ["ceramic", /ceramic|glass/],
    ["elastomer", /rubber|silicone|viton|epdm/],
    ["electronic", /pcb|board|semiconductor|silicon/],
    ["fluid", /oil|grease|solvent|coolant|reagent/],
  ] as const;
  return mappings.filter(([, pattern]) => pattern.test(haystack)).map(([label]) => label);
}

function relatedPartNumbers(relations: CateoArtifactRelation[] | undefined, kinds: string[]): string[] {
  return unique((relations ?? [])
    .filter((relation) => relation.targetType === "part" && kinds.includes(relation.kind))
    .map((relation) => relation.targetId));
}

function relatedDocumentRefs(relations: CateoArtifactRelation[] | undefined): string[] {
  return unique((relations ?? [])
    .filter((relation) => relation.targetType === "document")
    .map((relation) => relation.targetId));
}

function mergeProjectedObjectMetadata(
  current: ReturnType<typeof toProjectedObjectMetadata>,
  incoming: ReturnType<typeof toProjectedObjectMetadata>,
): ReturnType<typeof toProjectedObjectMetadata> {
  if (!current) return incoming;
  if (!incoming) return current;
  return {
    category: current.category ?? incoming.category,
    categoryLabel: current.categoryLabel ?? incoming.categoryLabel,
    persistentObjectId: current.persistentObjectId ?? incoming.persistentObjectId,
    lifecycleState: current.lifecycleState ?? incoming.lifecycleState,
    documentType: current.documentType ?? incoming.documentType,
    controlledVocabulary: unique([...(current.controlledVocabulary ?? []), ...(incoming.controlledVocabulary ?? [])]),
  };
}

function mergeProjectedConfigurationFingerprint(
  current: ReturnType<typeof toProjectedConfigurationFingerprint>,
  incoming: ReturnType<typeof toProjectedConfigurationFingerprint>,
): ReturnType<typeof toProjectedConfigurationFingerprint> {
  if (!current) return incoming;
  if (!incoming) return current;
  return {
    fingerprintId: current.fingerprintId ?? incoming.fingerprintId,
    serialNumber: current.serialNumber ?? incoming.serialNumber,
    softwareVersions: unique([...(current.softwareVersions ?? []), ...(incoming.softwareVersions ?? [])]),
    geography: current.geography ?? incoming.geography,
    assetId: current.assetId ?? incoming.assetId,
    summary: current.summary ?? incoming.summary,
    hash: current.hash ?? incoming.hash,
  };
}

function summarizeEffectivityLabel(effectivity: ReturnType<typeof toProjectedEffectivityRules>): string | undefined {
  const tokens = effectivity.flatMap((rule) => [
    ...(rule.serialRanges ?? []),
    ...(rule.softwareVersions ?? []),
    ...(rule.geographies ?? []),
    ...(rule.notes ?? []),
  ]);
  const summary = unique(tokens).join(" | ");
  return summary || undefined;
}

function buildBomEdges(metadata: NonNullable<CateoArtifactRecord["revisions"][number]["metadata"]>, currentPartNumber: string): Array<{ parentPartNumber?: string; childPartNumber?: string; quantity?: number; effectivityLabel?: string }> {
  const effectivity = toProjectedEffectivityRules(metadata.effectivity);
  const effectivityLabel = summarizeEffectivityLabel(effectivity);
  const parentPartNumber = metadata.parts?.primaryPartNumber ?? metadata.partNumber ?? currentPartNumber;
  const lineEdges = (metadata.parts?.requiredPartLines ?? []).map((line) => ({
    parentPartNumber,
    childPartNumber: line.partNumber,
    quantity: undefined,
    effectivityLabel,
  }));
  const relationEdges = (metadata.relations ?? []).flatMap((relation) => {
    if (relation.targetType !== "part") return [];
    if (relation.kind === "has-child" || relation.kind === "requires-part") {
      return [{ parentPartNumber, childPartNumber: relation.targetId, quantity: undefined, effectivityLabel }];
    }
    if (relation.kind === "has-parent" || relation.kind === "belongs-to-component") {
      return [{ parentPartNumber: relation.targetId, childPartNumber: currentPartNumber, quantity: undefined, effectivityLabel }];
    }
    return [];
  });
  return uniqueObjects([...lineEdges, ...relationEdges]);
}

function emptyTaxonomySnapshot(): CateoControlledTaxonomySnapshot {
  return {
    version: PART_MASTER_VERSION,
    updatedAt: new Date(0).toISOString(),
    dimensions: {
      domains: [],
      disciplines: [],
      subsystems: [],
      failureMechanisms: [],
      failureEffects: [],
      operatingStates: [],
      environments: [],
      componentPaths: [],
      locationPaths: [],
      failureCodes: [],
      productOfferings: [],
      taskClasses: [],
    },
  };
}

function emptySnapshot(): CateoPartMasterSnapshot {
  return {
    version: PART_MASTER_VERSION,
    updatedAt: new Date(0).toISOString(),
    stats: {
      partCount: 0,
      manufacturerCount: 0,
      duplicateArtifactCount: 0,
      releasedArtifactCount: 0,
      unresolvedPartCount: 0,
    },
    parts: [],
    taxonomy: emptyTaxonomySnapshot(),
  };
}

function collectPartNumbers(record: CateoArtifactRecord, linkedCase?: CateoCaseRecord | null): string[] {
  const latest = record.revisions.at(-1);
  const metadata = latest?.metadata;
  return unique([
    metadata?.parts?.primaryPartNumber,
    metadata?.partNumber,
    linkedCase?.context.partResolution?.partNumber,
    linkedCase?.input.partNumber,
    ...(metadata?.parts?.requiredPartLines ?? []).map((line) => line.partNumber),
  ]);
}

export function buildCateoPartMaster(args: { artifactRecords: CateoArtifactRecord[]; caseRecords: CateoCaseRecord[] }): CateoPartMasterSnapshot {
  const caseById = new Map(args.caseRecords.map((record) => [record.caseId, record]));
  const partMap = new Map<string, CateoPartMasterRecord>();
  const manufacturers = new Set<string>();
  const domains = new Map<string, { count: number; samples: Set<string> }>();
  const disciplines = new Map<string, { count: number; samples: Set<string> }>();
  const subsystems = new Map<string, { count: number; samples: Set<string> }>();
  const failureMechanisms = new Map<string, { count: number; samples: Set<string> }>();
  const failureEffects = new Map<string, { count: number; samples: Set<string> }>();
  const operatingStates = new Map<string, { count: number; samples: Set<string> }>();
  const environments = new Map<string, { count: number; samples: Set<string> }>();
  const componentPaths = new Map<string, { count: number; samples: Set<string> }>();
  const locationPaths = new Map<string, { count: number; samples: Set<string> }>();
  const failureCodes = new Map<string, { count: number; samples: Set<string> }>();
  const productOfferings = new Map<string, { count: number; samples: Set<string> }>();
  const taskClasses = new Map<string, { count: number; samples: Set<string> }>();

  for (const artifact of args.artifactRecords) {
    const latest = artifact.revisions.at(-1);
    const metadata = latest?.metadata;
    if (!latest || !metadata) continue;
    const linkedCase = caseById.get(artifact.caseId) ?? null;
    const partNumbers = collectPartNumbers(artifact, linkedCase);
    if (partNumbers.length === 0) continue;

    for (const rawPartNumber of partNumbers) {
      const normalizedPart = normalizePartNumber(rawPartNumber);
      if (!normalizedPart) continue;
      const partNumberDisplay = displayPartNumber(rawPartNumber) ?? normalizedPart;
      const projectedObjectMetadata = toProjectedObjectMetadata(metadata);
      const projectedEffectivity = toProjectedEffectivityRules(metadata.effectivity);
      const projectedRelationships = toProjectedRelationships(metadata.relations);
      const projectedChangeHistory = toProjectedChangeHistory(metadata.changeHistory);
      const projectedConfigurationFingerprint = toProjectedConfigurationFingerprint(metadata);
      const projectedExternalSystemLinks = toProjectedExternalSystemLinks(metadata.externalSystemIds);
      const projectedDeepMetadata = deriveDeepMetadataFromArtifactMetadata(metadata);
      const projectedBomEdges = buildBomEdges(metadata, partNumberDisplay);
      const current = partMap.get(normalizedPart) ?? {
        canonicalPartNumber: partNumberDisplay,
        normalizedPartNumber: normalizedPart,
        displayTitle: metadata.parts?.primaryPartDescription ?? metadata.partDescription ?? metadata.artifactTitle ?? normalizedPart,
        description: metadata.parts?.primaryPartDescription ?? metadata.partDescription ?? undefined,
        manufacturer: metadata.asset?.manufacturer ?? undefined,
        partFamily: metadata.parts?.requiredPartLines?.find((line) => normalizePartNumber(line.partNumber) === normalizedPart)?.partFamily,
        lifecycleState: metadata.lifecycleState,
        persistentObjectId: metadata.objectMetadata?.persistentObjectId,
        entityTypes: [],
        parentPartNumbers: [],
        childPartNumbers: [],
        assemblyPartNumbers: [],
        componentPartNumbers: [],
        materialClasses: [],
        specificationRefs: [],
        aliases: [],
        interchangeablePartNumbers: [],
        componentTitles: [],
        taxonomyTags: [],
        productOfferings: [],
        documentTypes: metadata.documentType ? [metadata.documentType] : [],
        taskClasses: [],
        failureCodes: [],
        failureModes: [],
        organizations: [],
        assetIds: [],
        workOrderIds: [],
        artifactIds: [],
        caseIds: [],
        relationTargets: [],
        objectMetadata: projectedObjectMetadata,
        effectivity: projectedEffectivity,
        relationships: projectedRelationships,
        bomEdges: projectedBomEdges,
        changeHistory: projectedChangeHistory,
        configurationFingerprint: projectedConfigurationFingerprint,
        externalSystemLinks: projectedExternalSystemLinks,
        deepMetadata: projectedDeepMetadata,
        approvalStates: {},
        riskTiers: [],
        lastSeenAt: artifact.updatedAt,
        sourceEvidenceCount: 0,
        duplicateArtifactCount: 0,
        releasedArtifactCount: 0,
        taxonomy: {
          domains: [],
          disciplines: [],
          subsystems: [],
          failureMechanisms: [],
          failureEffects: [],
          operatingStates: [],
          environments: [],
          componentPaths: [],
          locationPaths: [],
        },
      } satisfies CateoPartMasterRecord;

      current.canonicalPartNumber = current.canonicalPartNumber || (displayPartNumber(rawPartNumber) ?? normalizedPart);
      current.displayTitle = current.displayTitle || metadata.partDescription || normalizedPart;
      current.description = current.description || metadata.parts?.primaryPartDescription || metadata.partDescription || undefined;
      current.manufacturer = current.manufacturer || metadata.asset?.manufacturer || undefined;
      current.partFamily = current.partFamily || metadata.parts?.requiredPartLines?.find((line) => normalizePartNumber(line.partNumber) === normalizedPart)?.partFamily || undefined;
      current.lifecycleState = current.lifecycleState || metadata.lifecycleState;
      current.persistentObjectId = current.persistentObjectId || metadata.objectMetadata?.persistentObjectId;
      current.objectMetadata = mergeProjectedObjectMetadata(current.objectMetadata, projectedObjectMetadata);
      current.configurationFingerprint = mergeProjectedConfigurationFingerprint(current.configurationFingerprint, projectedConfigurationFingerprint);
      current.deepMetadata = mergeProjectedDeepMetadata(current.deepMetadata, projectedDeepMetadata);
      const relationTargets = appendRelationTargets([], metadata.relations);
      const childPartNumbers = unique([
        ...relatedPartNumbers(metadata.relations, ["requires-part", "has-child"]),
        ...(metadata.parts?.requiredPartLines ?? []).map((line) => line.partNumber),
      ]);
      const parentPartNumbers = relatedPartNumbers(metadata.relations, ["belongs-to-component", "has-parent"]);
      current.entityTypes = unique([...current.entityTypes, ...inferEntityTypes({ displayTitle: current.displayTitle, description: current.description, taxonomyTags: metadata.taxonomyTags, componentTitle: metadata.componentTitle, requiredPartCount: metadata.parts?.requiredPartLines?.length, relationTargets, objectCategory: metadata.objectMetadata?.objectCategory })]);
      current.parentPartNumbers = unique([...current.parentPartNumbers, ...parentPartNumbers]);
      current.childPartNumbers = unique([...current.childPartNumbers, ...childPartNumbers]);
      current.assemblyPartNumbers = unique([...current.assemblyPartNumbers, ...(current.entityTypes.includes("assembly") ? [current.canonicalPartNumber] : []), ...parentPartNumbers]);
      current.componentPartNumbers = unique([...current.componentPartNumbers, ...(current.entityTypes.includes("component") ? [current.canonicalPartNumber] : []), ...childPartNumbers]);
      current.materialClasses = unique([...current.materialClasses, ...inferMaterialClasses({ displayTitle: current.displayTitle, description: current.description, taxonomyTags: metadata.taxonomyTags })]);
      current.specificationRefs = unique([...current.specificationRefs, ...relatedDocumentRefs(metadata.relations), ...(metadata.parts?.billOfMaterialsRefs ?? [])]);
      current.aliases = unique([
        ...current.aliases,
        ...partNumbers,
        metadata.partNumber,
        ...(metadata.parts?.requiredPartLines ?? []).map((line) => line.partNumber),
      ]);
      current.interchangeablePartNumbers = unique([
        ...current.interchangeablePartNumbers,
        ...(metadata.parts?.interchangeablePartNumbers ?? []),
        ...(metadata.parts?.requiredPartLines ?? []).flatMap((line) => line.interchangeablePartNumbers ?? []),
      ]);
      current.componentTitles = unique([...current.componentTitles, metadata.componentTitle]);
      current.taxonomyTags = unique([...current.taxonomyTags, ...(metadata.taxonomyTags ?? [])]);
      current.productOfferings = unique([...current.productOfferings, linkedCase?.input.productOffering]) as CateoProductOffering[];
      current.documentTypes = unique([...(current.documentTypes ?? []), metadata.documentType]);
      current.taskClasses = unique([...current.taskClasses, linkedCase?.context.taskClass, metadata.taskClass]) as CateoTaskClass[];
      current.failureCodes = unique([...current.failureCodes, metadata.classification?.failureCode, linkedCase?.context.failureCode?.code]);
      current.failureModes = unique([...current.failureModes, metadata.classification?.failureMode, metadata.classification?.failureLabel]);
      current.organizations = unique([...current.organizations, linkedCase?.requester?.organization]);
      current.assetIds = unique([...current.assetIds, metadata.asset?.assetId, artifact.assetId]);
      current.workOrderIds = unique([...current.workOrderIds, metadata.workOrder?.workOrderId, artifact.workOrderId]);
      current.artifactIds = unique([...current.artifactIds, artifact.artifactId]);
      current.caseIds = unique([...current.caseIds, artifact.caseId]);
      current.relationTargets = appendRelationTargets(current.relationTargets, metadata.relations);
      current.effectivity = uniqueObjects([...(current.effectivity ?? []), ...projectedEffectivity]);
      current.relationships = uniqueObjects([...(current.relationships ?? []), ...projectedRelationships]);
      current.bomEdges = uniqueObjects([...(current.bomEdges ?? []), ...projectedBomEdges]);
      current.changeHistory = uniqueObjects([...(current.changeHistory ?? []), ...projectedChangeHistory]);
      current.externalSystemLinks = uniqueObjects([...(current.externalSystemLinks ?? []), ...projectedExternalSystemLinks]);
      current.riskTiers = unique([...current.riskTiers, linkedCase?.input.workflow?.riskTier]) as CateoRiskTier[];
      current.approvalStates[latest.approvalState] = (current.approvalStates[latest.approvalState] ?? 0) + 1;
      current.lastSeenAt = current.lastSeenAt > artifact.updatedAt ? current.lastSeenAt : artifact.updatedAt;
      current.sourceEvidenceCount += Math.max(1, metadata.evidence?.attachmentIds?.length ?? 0) + Math.max(0, metadata.evidence?.documentRefs?.length ?? 0);
      if ((artifact.duplicateState ?? "canonical") !== "canonical") {
        current.duplicateArtifactCount += 1;
      }
      if (latest.approvalState === "approved" || latest.approvalState === "reviewed") {
        current.releasedArtifactCount += 1;
      }
      current.taxonomy.domains = unique([...current.taxonomy.domains, metadata.taxonomy.domain]);
      current.taxonomy.disciplines = unique([...current.taxonomy.disciplines, metadata.taxonomy.discipline]);
      current.taxonomy.subsystems = unique([...current.taxonomy.subsystems, metadata.taxonomy.subsystem]);
      current.taxonomy.failureMechanisms = unique([...current.taxonomy.failureMechanisms, metadata.taxonomy.failureMechanism]);
      current.taxonomy.failureEffects = unique([...current.taxonomy.failureEffects, metadata.taxonomy.failureEffect]);
      current.taxonomy.operatingStates = unique([...current.taxonomy.operatingStates, metadata.taxonomy.operatingState]);
      current.taxonomy.environments = unique([...current.taxonomy.environments, metadata.taxonomy.environment]);
      current.taxonomy.componentPaths = unique([...current.taxonomy.componentPaths, metadata.taxonomy.componentPath?.join(" > ")]);
      current.taxonomy.locationPaths = unique([...current.taxonomy.locationPaths, metadata.taxonomy.locationPath?.join(" > ")]);
      partMap.set(normalizedPart, current);

      if (current.manufacturer) manufacturers.add(current.manufacturer);
      pushTaxonomy(domains, metadata.taxonomy.domain, current.canonicalPartNumber);
      pushTaxonomy(disciplines, metadata.taxonomy.discipline, current.canonicalPartNumber);
      pushTaxonomy(subsystems, metadata.taxonomy.subsystem, current.canonicalPartNumber);
      pushTaxonomy(failureMechanisms, metadata.taxonomy.failureMechanism, current.canonicalPartNumber);
      pushTaxonomy(failureEffects, metadata.taxonomy.failureEffect, current.canonicalPartNumber);
      pushTaxonomy(operatingStates, metadata.taxonomy.operatingState, current.canonicalPartNumber);
      pushTaxonomy(environments, metadata.taxonomy.environment, current.canonicalPartNumber);
      pushTaxonomy(componentPaths, metadata.taxonomy.componentPath?.join(" > "), current.canonicalPartNumber);
      pushTaxonomy(locationPaths, metadata.taxonomy.locationPath?.join(" > "), current.canonicalPartNumber);
      pushTaxonomy(failureCodes, metadata.classification?.failureCode, current.canonicalPartNumber);
      pushTaxonomy(productOfferings, linkedCase?.input.productOffering, current.canonicalPartNumber);
      pushTaxonomy(taskClasses, linkedCase?.context.taskClass ?? metadata.taskClass, current.canonicalPartNumber);
    }
  }

  for (const record of args.caseRecords) {
    const resolvedPart = displayPartNumber(record.context.partResolution?.partNumber ?? record.input.partNumber);
    const normalizedPart = normalizePartNumber(resolvedPart);
    if (!normalizedPart || partMap.has(normalizedPart)) continue;
    partMap.set(normalizedPart, {
      canonicalPartNumber: resolvedPart ?? normalizedPart,
      normalizedPartNumber: normalizedPart,
      displayTitle: record.context.partResolution?.partDescription ?? record.context.title,
      description: record.context.partResolution?.partDescription ?? undefined,
      manufacturer: record.context.partResolution?.manufacturer ?? record.context.machine?.manufacturer ?? undefined,
      partFamily: undefined,
      lifecycleState: undefined,
      persistentObjectId: undefined,
      entityTypes: inferEntityTypes({ displayTitle: record.context.partResolution?.partDescription ?? record.context.title, description: record.context.partResolution?.partDescription, taxonomyTags: [record.input.businessType, record.context.issueType].filter(Boolean) as string[], componentTitle: record.context.machine?.model, objectCategory: record.context.partResolution?.partNumber?.toLowerCase().includes("ln") ? "ln" : undefined }),
      parentPartNumbers: [],
      childPartNumbers: [],
      assemblyPartNumbers: [],
      componentPartNumbers: [],
      materialClasses: inferMaterialClasses({ displayTitle: record.context.partResolution?.partDescription ?? record.context.title, description: record.context.partResolution?.partDescription, taxonomyTags: [record.input.businessType].filter(Boolean) as string[] }),
      specificationRefs: [],
      aliases: unique([resolvedPart, ...(record.context.partResolution?.aliases ?? [])]),
      interchangeablePartNumbers: [],
      componentTitles: [],
      taxonomyTags: [],
      productOfferings: unique([record.input.productOffering]) as CateoProductOffering[],
      documentTypes: [],
      taskClasses: unique([record.context.taskClass]) as CateoTaskClass[],
      failureCodes: unique([record.context.failureCode?.code]),
      failureModes: unique(record.context.partResolution?.failureModes ?? []),
      organizations: unique([record.requester?.organization]),
      assetIds: unique([record.context.asset?.assetId]),
      workOrderIds: unique([record.context.workOrder?.workOrderId]),
      artifactIds: unique(record.artifacts),
      caseIds: [record.caseId],
      relationTargets: [],
      objectMetadata: undefined,
      effectivity: [],
      relationships: [],
      bomEdges: [],
      changeHistory: [],
      configurationFingerprint: undefined,
      externalSystemLinks: [],
      deepMetadata: undefined,
      approvalStates: {},
      riskTiers: unique([record.input.workflow?.riskTier]) as CateoRiskTier[],
      lastSeenAt: record.updatedAt,
      sourceEvidenceCount: Math.max(1, record.context.attachments.length + record.context.serviceHistory.length),
      duplicateArtifactCount: 0,
      releasedArtifactCount: 0,
      taxonomy: {
        domains: [],
        disciplines: [],
        subsystems: [],
        failureMechanisms: [],
        failureEffects: [],
        operatingStates: [],
        environments: [],
        componentPaths: [],
        locationPaths: unique(record.context.asset?.locationHierarchy ?? record.context.machine?.locationHierarchy ?? []),
      },
    });
  }

  const parts = [...partMap.values()].sort((left, right) => left.canonicalPartNumber.localeCompare(right.canonicalPartNumber));
  const snapshot: CateoPartMasterSnapshot = {
    version: PART_MASTER_VERSION,
    updatedAt: new Date().toISOString(),
    stats: {
      partCount: parts.length,
      manufacturerCount: manufacturers.size,
      duplicateArtifactCount: parts.reduce((sum, part) => sum + part.duplicateArtifactCount, 0),
      releasedArtifactCount: parts.reduce((sum, part) => sum + part.releasedArtifactCount, 0),
      unresolvedPartCount: parts.filter((part) => !part.description || !part.manufacturer).length,
    },
    parts,
    taxonomy: {
      version: PART_MASTER_VERSION,
      updatedAt: new Date().toISOString(),
      dimensions: {
        domains: toTaxonomyPoints(domains),
        disciplines: toTaxonomyPoints(disciplines),
        subsystems: toTaxonomyPoints(subsystems),
        failureMechanisms: toTaxonomyPoints(failureMechanisms),
        failureEffects: toTaxonomyPoints(failureEffects),
        operatingStates: toTaxonomyPoints(operatingStates),
        environments: toTaxonomyPoints(environments),
        componentPaths: toTaxonomyPoints(componentPaths),
        locationPaths: toTaxonomyPoints(locationPaths),
        failureCodes: toTaxonomyPoints(failureCodes),
        productOfferings: toTaxonomyPoints(productOfferings),
        taskClasses: toTaxonomyPoints(taskClasses),
      },
    },
  };
  return snapshot;
}

export function syncCateoPartMaster(args: { artifactRecords: CateoArtifactRecord[]; caseRecords: CateoCaseRecord[] }): CateoPartMasterSnapshot {
  const snapshot = buildCateoPartMaster(args);
  writeProtectedJson(partMasterPath(), snapshot);
  return snapshot;
}

export function loadCateoPartMaster(): CateoPartMasterSnapshot {
  return readProtectedJson<CateoPartMasterSnapshot>(partMasterPath(), emptySnapshot());
}

export function listCateoPartMasterRecords(filters: CateoPartMasterFilters = {}): CateoPartMasterRecord[] {
  const q = filters.q?.trim().toLowerCase();
  const manufacturer = filters.manufacturer?.trim().toLowerCase();
  const productOffering = filters.productOffering?.trim().toLowerCase();
  const failureCode = filters.failureCode?.trim().toLowerCase();
  const partNumber = filters.partNumber?.trim().toLowerCase();
  return loadCateoPartMaster().parts
    .filter((part) => {
      const haystack = JSON.stringify({
        canonicalPartNumber: part.canonicalPartNumber,
        displayTitle: part.displayTitle,
        description: part.description,
        manufacturer: part.manufacturer,
        aliases: part.aliases,
        componentTitles: part.componentTitles,
        organizations: part.organizations,
        productOfferings: part.productOfferings,
        documentTypes: part.documentTypes,
        failureCodes: part.failureCodes,
        failureModes: part.failureModes,
        relationships: part.relationships,
        externalSystemLinks: part.externalSystemLinks,
        deepMetadata: part.deepMetadata,
      }).toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (manufacturer && !(part.manufacturer ?? "").toLowerCase().includes(manufacturer)) return false;
      if (productOffering && !part.productOfferings.some((value) => value.toLowerCase().includes(productOffering))) return false;
      if (failureCode && !part.failureCodes.some((value) => value.toLowerCase().includes(failureCode))) return false;
      if (partNumber && !part.canonicalPartNumber.toLowerCase().includes(partNumber) && !part.aliases.some((value) => value.toLowerCase().includes(partNumber))) return false;
      return true;
    })
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || left.canonicalPartNumber.localeCompare(right.canonicalPartNumber));
}

export function getCateoPartMasterRecord(partNumber: string): CateoPartMasterRecord | null {
  const normalizedPart = normalizePartNumber(partNumber);
  if (!normalizedPart) return null;
  return loadCateoPartMaster().parts.find((part) => part.normalizedPartNumber === normalizedPart) ?? null;
}

export function getCateoControlledTaxonomy(): CateoControlledTaxonomySnapshot {
  return loadCateoPartMaster().taxonomy;
}

