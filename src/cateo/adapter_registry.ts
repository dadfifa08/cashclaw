import { spawnSync } from "node:child_process";
import type { CateoAdapterCapability } from "./types.js";

interface AdapterDefinition {
  id: string;
  title: string;
  category: string;
  summary: string;
  command?: string;
  versionArgs?: string[];
  envVar?: string;
  upstream: string;
  notes: string[];
}

const ADAPTERS: AdapterDefinition[] = [
  {
    id: "opencv-aruco-measurement",
    title: "OpenCV ArUco Measurement",
    category: "measurement",
    summary: "Reference-marker and calibrated image measurement for rough dimensional estimates.",
    command: "python",
    versionArgs: ["--version"],
    envVar: "CATEO_OPENCV_PIPELINE",
    upstream: "opencv/opencv_contrib",
    notes: [
      "Best for single-image rough measurement when a known scale or ArUco marker is present.",
      "Use as a fast gate before heavier digital twin reconstruction.",
    ],
  },
  {
    id: "colmap-photogrammetry",
    title: "COLMAP Photogrammetry",
    category: "reconstruction",
    summary: "Sparse and dense multi-view reconstruction for geometry-driven inspection packages.",
    command: "colmap",
    versionArgs: ["-h"],
    envVar: "CATEO_COLMAP_BIN",
    upstream: "colmap/colmap",
    notes: [
      "Useful when multiple overlapping images exist and rough 3D structure matters.",
      "Pairs well with downstream CAD or deviation-analysis workflows.",
    ],
  },
  {
    id: "meshroom-reconstruction",
    title: "Meshroom Reconstruction",
    category: "reconstruction",
    summary: "AliceVision Meshroom pipeline for visual reconstruction and asset state capture.",
    command: "meshroom_batch",
    versionArgs: ["--help"],
    envVar: "CATEO_MESHROOM_BIN",
    upstream: "alicevision/meshroom",
    notes: [
      "Strong fit for richer visual evidence sets when operators can capture multiple viewpoints.",
      "Can seed digital twin datasets without changing the public chat workflow.",
    ],
  },
  {
    id: "freecad-cad-normalization",
    title: "FreeCAD Normalization",
    category: "cad",
    summary: "Creates or normalizes engineering geometry into reusable CAD-linked artifacts.",
    command: "FreeCADCmd",
    versionArgs: ["--help"],
    envVar: "CATEO_FREECAD_BIN",
    upstream: "FreeCAD/FreeCAD",
    notes: [
      "Useful for 2D/3D CAD cleanup, derived dimensions, and engineering package attachments.",
      "Works well as a downstream step after photogrammetry or manual measurement.",
    ],
  },
  {
    id: "librecad-2d-extraction",
    title: "LibreCAD 2D Extraction",
    category: "cad",
    summary: "2D CAD drafting and markup path for work instructions and layout-specific inspections.",
    command: "librecad",
    versionArgs: ["--help"],
    envVar: "CATEO_LIBRECAD_BIN",
    upstream: "LibreCAD/LibreCAD",
    notes: [
      "Best for flat layouts, wiring, panel geometry, and quick 2D output packages.",
    ],
  },
  {
    id: "ifcopenshell-bim-bridge",
    title: "IfcOpenShell BIM Bridge",
    category: "cad",
    summary: "IFC/BIM parsing path for facility-linked assets and location-hierarchy context.",
    command: "python",
    versionArgs: ["--version"],
    envVar: "CATEO_IFCOPENSHELL_PIPELINE",
    upstream: "IfcOpenShell/IfcOpenShell",
    notes: [
      "Useful when enterprise facility models or IFC exports already exist.",
    ],
  },
  {
    id: "material-segmentation-stack",
    title: "Material Segmentation Stack",
    category: "materials",
    summary: "Future material-recognition lane for surface, coating, and substrate estimation.",
    envVar: "CATEO_MATERIAL_PIPELINE",
    upstream: "apple/ml-dms-dataset",
    notes: [
      "Treat outputs as advisory unless corroborated by documentation or human review.",
      "Good candidate for future fine-tuning once Cateo has enough labeled field images.",
    ],
  },
  {
    id: "unsloth-training-export",
    title: "Unsloth Training Export",
    category: "learning",
    summary: "Dataset export and fine-tuning lane for turning Cateo artifacts into local model improvements.",
    command: "python",
    versionArgs: ["--version"],
    envVar: "CATEO_UNSLOTH_PIPELINE",
    upstream: "unslothai/unsloth",
    notes: [
      "Best used after artifact and dataset schemas stabilize.",
      "Lets you keep the three-model architecture while gradually localizing training later.",
    ],
  },
];

function detectCommand(command: string, versionArgs: string[] | undefined): boolean {
  try {
    const result = spawnSync(command, versionArgs ?? ["--version"], {
      encoding: "utf-8",
      timeout: 2500,
      windowsHide: true,
    });
    return result.status === 0 || Boolean(result.stdout) || Boolean(result.stderr);
  } catch {
    return false;
  }
}

function statusFor(definition: AdapterDefinition): { status: CateoAdapterCapability["status"]; notes: string[] } {
  if (definition.command && detectCommand(definition.command, definition.versionArgs)) {
    return {
      status: "detected",
      notes: [
        `${definition.command} was detected on this machine.`,
        ...definition.notes,
      ],
    };
  }

  if (definition.envVar && process.env[definition.envVar]?.trim()) {
    return {
      status: "available",
      notes: [
        `${definition.envVar} is configured for later activation.`,
        ...definition.notes,
      ],
    };
  }

  return {
    status: "planned",
    notes: definition.notes,
  };
}

export function listCateoAdapters(): CateoAdapterCapability[] {
  return ADAPTERS.map((definition) => {
    const status = statusFor(definition);
    return {
      id: definition.id,
      title: definition.title,
      category: definition.category,
      status: status.status,
      summary: definition.summary,
      notes: status.notes,
      command: definition.command,
      envVar: definition.envVar,
      upstream: definition.upstream,
    };
  });
}

export function summarizeAvailableAdapterIds(): string[] {
  return listCateoAdapters()
    .filter((adapter) => adapter.status === "detected" || adapter.status === "available")
    .map((adapter) => adapter.id);
}
