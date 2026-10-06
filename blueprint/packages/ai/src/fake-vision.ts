/**
 * Deterministic fake VisionProvider (Phase 18, ADR-030) — TEST/DEV ONLY.
 *
 * Mirrors DeterministicFakeLlmProvider: a predictable, honest multimodal
 * provider for local tests/E2E. It NEVER fabricates: every observation cites
 * keywords that actually occur in the provided `context` (the caption/profile
 * text accompanying the image). With an empty/keyword-free context it returns
 * NO observations — an image without usable accompanying text yields no
 * claims, exactly like an unavailable modality.
 *
 * Selection: never chosen silently. `selectAiRuntime` attaches it only for
 * AI_PROVIDER=fake (or an explicit test opt-in); production HTTP runs use
 * HttpVisionProvider only when AI_VISION_MODEL is configured.
 *
 * Determinism: fixed keyword dictionaries, constant confidences, stable
 * iteration order → the same input always yields the same output.
 */

import type { AiMetadata, VisualAnalysis } from './interfaces.ts';
import { aliasKey } from '@ulip/domain';

interface VisionRule {
  /** Canonical observable label (what the image is "of"). */
  label: string;
  keywords: readonly string[];
  confidence: number;
}

/**
 * Image-signal rules. In tests these are matched against the image's
 * ACCOMPANYING TEXT (caption/bio), which is the only information the fake
 * provider legitimately "sees". A real provider sees pixels; the fake sees
 * context — the honesty boundary is documented and deterministic.
 */
const OBSERVATION_RULES: readonly VisionRule[] = [
  { label: 'printer product photo', keywords: ['printer parts', 'قطعات پرینتر', 'fuser', 'toner', 'laserjet'], confidence: 0.82 },
  { label: 'hair coloring result photo', keywords: ['balayage', 'بالایاژ', 'hair coloring', 'رنگ مو', 'highlights'], confidence: 0.8 },
  { label: 'retail storefront photo', keywords: ['store', 'shop', 'فروشگاه', 'showroom'], confidence: 0.75 },
  { label: 'food product photo', keywords: ['food', 'restaurant', 'رستوران', 'کافه', 'catering'], confidence: 0.78 },
  { label: 'product catalog photo', keywords: ['catalog', 'کاتالوگ', 'price list', 'لیست قیمت'], confidence: 0.72 },
];

const FAKE_VISION_META = {
  promptVersion: 'fake-vision-v1',
  schemaVersion: '1',
};

/** Canonicalizes Persian/Arabic characters + ZWNJ for stable keyword matching. */
function normalizeText(text: string): string {
  return aliasKey(text);
}

export class DeterministicFakeVisionProvider {
  readonly isDeterministicFake = true;
  private readonly providerName: string;
  private readonly modelVersion: string;

  constructor(providerName = 'fake:deterministic:vision', modelVersion = 'fake-vision-1') {
    this.providerName = providerName;
    this.modelVersion = modelVersion;
  }

  metadata(): AiMetadata {
    return {
      provider: this.providerName,
      modelVersion: this.modelVersion,
      ...FAKE_VISION_META,
    };
  }

  async analyzeImage(input: { uri: string; context?: string }): Promise<VisualAnalysis> {
    const context = input.context ?? '';
    const normalized = normalizeText(context);
    const observations = [];
    for (const rule of OBSERVATION_RULES) {
      for (const keyword of rule.keywords) {
        if (normalized.includes(normalizeText(keyword))) {
          observations.push({ label: rule.label, confidence: rule.confidence, evidenceIds: [] });
          break;
        }
      }
    }
    return { observations, meta: this.metadata() };
  }

  async analyzeImages(input: { uris: string[]; context?: string }): Promise<VisualAnalysis[]> {
    const out: VisualAnalysis[] = [];
    for (const uri of input.uris) {
      out.push(await this.analyzeImage({ uri, ...(input.context !== undefined ? { context: input.context } : {}) }));
    }
    return out;
  }
}
