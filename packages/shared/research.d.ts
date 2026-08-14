import type { z } from "zod";

export type ResearchSymbol = string | "*";
export type ScrapeFormat = "auto" | "html" | "text" | "json";
export type MarketSentiment = "bearish" | "neutral" | "bullish" | "mixed";

export interface ScrapeResearchStep {
  readonly id: string;
  readonly kind: "scrape";
  readonly adapter: "web.page.v1";
  readonly request: Readonly<{
    sourceId: string;
    pathTemplate: string;
    query?: Readonly<Record<string, string>>;
    format: ScrapeFormat;
  }>;
  readonly limits: Readonly<{
    timeoutMs: number;
    maxBytes: number;
  }>;
}

export interface SummarizeResearchStep {
  readonly id: string;
  readonly kind: "summarize";
  readonly adapter: "ai.cli.summary.v1";
  readonly dependsOn: readonly string[];
  readonly promptTemplate: "market-summary.v1";
  readonly responseSchema: "market-summary.v1";
  readonly limits: Readonly<{
    timeoutMs: number;
    maxInputBytes: number;
  }>;
}

export type ResearchStep = ScrapeResearchStep | SummarizeResearchStep;

export interface ResearchPlanV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly symbols: readonly ResearchSymbol[];
  readonly steps: readonly ResearchStep[];
  readonly outputStep: string;
  readonly delivery: Readonly<{
    strategy: boolean;
    required: boolean;
    maxAgeMs: number;
  }>;
}

export interface MarketResearchSummary {
  readonly overview: string;
  readonly keyDrivers: readonly string[];
  readonly risks: readonly string[];
  readonly opportunities: readonly string[];
  readonly sentiment: MarketSentiment;
  readonly confidence: number;
}

export interface ResearchSourceProvenance {
  readonly stepId: string;
  readonly sourceId: string;
  readonly url: string;
  readonly title: string | null;
  readonly fetchedAt: number;
  readonly publishedAt: number | null;
  readonly contentType: string;
  readonly contentHash: string;
}

export interface ResearchSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly planId: string;
  readonly planVersionId: string;
  readonly schemaVersion: 1;
  readonly symbol: string;
  readonly asOf: number;
  readonly availableAt: number;
  readonly expiresAt: number | null;
  readonly summary: MarketResearchSummary;
  readonly sources: readonly ResearchSourceProvenance[];
  readonly sourceBundleHash: string;
  readonly aiInputHash: string;
  readonly summarizerConfigHash: string;
  readonly inputDocuments: readonly ResearchInputDocument[];
  readonly promptHash: string;
  readonly model: string;
  readonly contentHash: string;
}

export interface ResearchInputDocument {
  readonly stepId: string;
  readonly sourceId: string;
  readonly contentHash: string;
  readonly sourceBytes: number;
  readonly includedBytes: number;
  readonly truncated: boolean;
}

export interface AvailableResearchFrame {
  readonly status: "available";
  readonly symbol: string;
  readonly decisionAt: number;
  readonly snapshot: ResearchSnapshot;
}

export interface UnavailableResearchFrame {
  readonly status: "unavailable";
  readonly symbol: string;
  readonly decisionAt: number;
  readonly reason: string;
}

export type ResearchFrame = AvailableResearchFrame | UnavailableResearchFrame;

export const ResearchSourceProvenanceSchema: z.ZodType<ResearchSourceProvenance>;
export const SymbolOrWildcardSchema: z.ZodType<ResearchSymbol>;
export const ScrapeResearchStepSchema: z.ZodType<ScrapeResearchStep>;
export const SummarizeResearchStepSchema: z.ZodType<SummarizeResearchStep>;
export const ResearchStepSchema: z.ZodType<ResearchStep>;
export const ResearchPlanV1Schema: z.ZodType<ResearchPlanV1>;
export const ResearchPlanSchema: typeof ResearchPlanV1Schema;
export const MarketResearchSummarySchema: z.ZodType<MarketResearchSummary>;
export const ResearchInputDocumentSchema: z.ZodType<ResearchInputDocument>;
export const ResearchSnapshotSchema: z.ZodType<ResearchSnapshot>;
export const AvailableResearchFrameSchema: z.ZodType<AvailableResearchFrame>;
export const UnavailableResearchFrameSchema: z.ZodType<UnavailableResearchFrame>;
export const ResearchFrameSchema: z.ZodType<ResearchFrame>;
