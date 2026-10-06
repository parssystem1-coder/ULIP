/**
 * Evaluation arms (Phase 17 §6).
 *
 * Arms are strategies over the SAME evidence pipeline the production analysis
 * runtime uses:
 *   RULES_ONLY                    → deterministic alias rules over evidence
 *   LLM_ONLY                      → the LLMProvider under test
 *   RULES_THEN_LLM                → rules fill gaps left by the LLM
 *   LLM_THEN_DECISION_PROVIDER    → Jev refines the LLM answer (optional)
 *   RULES_LLM_DECISION_PROVIDER   → rules fill gaps, then Jev (optional)
 *
 * Only configured providers execute: without a DecisionProvider the two Jev
 * arms are recorded NOT_CONFIGURED (§6) — never fabricated. The evaluation
 * framework does NOT reimplement the AI stack; it reuses @ulip/ai contracts
 * and the evidence-first conventions (evidence ids must exist).
 */

import { aliasKey } from '@ulip/domain';
import type {
  ExtractionResult,
  FieldPrediction,
  LLMProvider,
  ProfileExtractionInput,
  StructuredProfile,
} from '@ulip/ai';
import type { EvalArmAvailability, EvalArmId, EvalCase } from './contracts.ts';
import { EVAL_ARM_IDS } from './contracts.ts';

// ---------------------------------------------------------------------------
// Case → extraction input (the real provider contract, not a private one)
// ---------------------------------------------------------------------------

/** Deterministic synthetic evidence id — content is embedded in the text. */
function caseSampleId(caseItem: EvalCase, index: number): string {
  return `eval:${caseItem.caseId}:s${index}`;
}

export function buildExtractionInput(caseItem: EvalCase): ProfileExtractionInput {
  const samples: ProfileExtractionInput['contentSamples'] = [];
  const push = (id: string, text: string): void => {
    if (text.trim() !== '') samples.push({ contentId: id, text });
  };
  const name = caseItem.input.displayName ?? caseItem.input.name;
  push(caseSampleId(caseItem, 0), `name: ${name}`);
  if (caseItem.input.bio !== undefined) push(caseSampleId(caseItem, 1), caseItem.input.bio);
  if (caseItem.input.categories !== undefined) {
    for (let i = 0; i < caseItem.input.categories.length; i++) {
      push(caseSampleId(caseItem, 10 + i), `category: ${caseItem.input.categories[i]}`);
    }
  }
  if (caseItem.input.city !== undefined) {
    push(caseSampleId(caseItem, 20), `location: ${caseItem.input.city}${caseItem.input.country ? `, ${caseItem.input.country}` : ''}`);
  }
  if (caseItem.input.website !== undefined) push(caseSampleId(caseItem, 21), `website: ${caseItem.input.website}`);
  if (caseItem.input.username !== undefined) push(caseSampleId(caseItem, 22), `username: ${caseItem.input.username}`);
  if (caseItem.input.posts !== undefined) {
    for (let i = 0; i < caseItem.input.posts.length; i++) {
      push(caseSampleId(caseItem, 30 + i), caseItem.input.posts[i]?.text ?? '');
    }
  }
  return {
    profileText: samples.map((s) => s.text ?? '').join('\n'),
    locationHints: caseItem.input.city !== undefined ? [caseItem.input.city] : [],
    contentSamples: samples,
    taxonomySnapshot: [],
    locale: caseItem.locale,
  };
}

// ---------------------------------------------------------------------------
// Deterministic rules (the RULES_ONLY capability, mirroring seed aliases)
// ---------------------------------------------------------------------------

export interface RulesTable {
  taxonomyAliases: { label: string; aliases: string[]; kind?: string }[];
  locationAliases: { alias: string; city: string }[];
  snapshot: { nodeId: string; label: string; nodeKind: string }[];
}

export interface RulesAnswer {
  businessType: { label: string; confidence: number; evidenceIds: string[] } | null;
  industry: { label: string; confidence: number; evidenceIds: string[] } | null;
  specialty: { label: string; confidence: number; evidenceIds: string[] }[];
  subSpecialty: { label: string; confidence: number; evidenceIds: string[] }[];
  brand: { label: string; confidence: number; evidenceIds: string[] }[];
  city: { label: string; confidence: number; evidenceIds: string[] } | null;
}

interface Sample {
  id: string;
  normalized: string;
}

function aliasHits(samples: readonly Sample[], aliases: readonly string[]): string[] {
  for (const alias of aliases) {
    const key = aliasKey(alias);
    const ids = samples.filter((s) => s.normalized.includes(key)).map((s) => s.id).sort();
    if (ids.length > 0) return ids;
  }
  return [];
}

const KIND_ORDER = ['BUSINESS_TYPE', 'INDUSTRY', 'SPECIALTY', 'SUB_SPECIALTY', 'BRAND'] as const;

export function runRules(caseItem: EvalCase, table: RulesTable, input: ProfileExtractionInput): RulesAnswer {
  const samples: Sample[] = input.contentSamples.map((s) => ({
    id: s.contentId,
    normalized: aliasKey(s.text ?? ''),
  }));

  const answer: RulesAnswer = {
    businessType: null,
    industry: null,
    specialty: [],
    subSpecialty: [],
    brand: [],
    city: null,
  };

  for (const kind of KIND_ORDER) {
    for (const entry of table.taxonomyAliases) {
      if (entry.kind !== kind) continue;
      const ids = aliasHits(samples, entry.aliases);
      if (ids.length === 0) continue;
      if (kind === 'BUSINESS_TYPE' && answer.businessType === null) {
        answer.businessType = { label: entry.label, confidence: 0.95, evidenceIds: ids };
      } else if (kind === 'INDUSTRY' && answer.industry === null) {
        answer.industry = { label: entry.label, confidence: 0.9, evidenceIds: ids };
      } else if (kind === 'SPECIALTY') {
        answer.specialty.push({ label: entry.label, confidence: 0.85, evidenceIds: ids });
      } else if (kind === 'SUB_SPECIALTY') {
        answer.subSpecialty.push({ label: entry.label, confidence: 0.8, evidenceIds: ids });
      } else if (kind === 'BRAND') {
        answer.brand.push({ label: entry.label, confidence: 0.9, evidenceIds: ids });
      }
    }
  }

  for (const loc of table.locationAliases) {
    const key = aliasKey(loc.alias);
    const ids = samples.filter((s) => s.normalized.includes(key)).map((s) => s.id).sort();
    if (ids.length > 0) {
      answer.city = { label: loc.city, confidence: 0.9, evidenceIds: ids };
      break;
    }
  }

  // Dedup specialties/sub-specialties by label (first alias hit wins, deterministic).
  const seen = new Set<string>();
  answer.specialty = answer.specialty.filter((s) =>
    seen.has(s.label) ? false : (seen.add(s.label), true),
  );
  const seenSub = new Set<string>();
  answer.subSpecialty = answer.subSpecialty.filter((s) =>
    seenSub.has(s.label) ? false : (seenSub.add(s.label), true),
  );
  return answer;
}

// ---------------------------------------------------------------------------
// Arm label composition
// ---------------------------------------------------------------------------

export interface Prediction {
  labels: string[];
  confidence: number | null;
  /** Evidence ids backing every label in this prediction (citable). */
  evidenceIds: string[];
}

export interface ArmAnswer {
  businessType: Prediction;
  industry: Prediction;
  specialty: Prediction;
  subSpecialty: Prediction;
  brand: Prediction;
  location: Prediction;
}

function predictionFromField(p: FieldPrediction | undefined, snapshotLabels: ReadonlyMap<string, string>): Prediction {
  if (p === undefined || p.availability === 'UNAVAILABLE' || p.evidenceIds.length === 0) {
    return { labels: [], confidence: null, evidenceIds: [] };
  }
  const label = snapshotLabels.get(p.value) ?? p.value;
  return { labels: [label], confidence: p.confidence, evidenceIds: [...p.evidenceIds].sort() };
}

export function answerFromProfile(
  profile: StructuredProfile,
  snapshotLabels: ReadonlyMap<string, string>,
): ArmAnswer {
  const specialties = profile.specialties
    .filter((s) => s.availability !== 'UNAVAILABLE' && s.evidenceIds.length > 0)
    .map((s) => ({ label: snapshotLabels.get(s.value) ?? s.value, confidence: s.confidence }));
  return {
    businessType: predictionFromField(profile.businessType, snapshotLabels),
    industry: predictionFromField(profile.industry, snapshotLabels),
    specialty: {
      labels: specialties.map((s) => s.label),
      confidence:
        specialties.length === 0
          ? null
          : specialties.reduce((sum, s) => sum + s.confidence, 0) / specialties.length,
      evidenceIds: [...new Set(profile.specialties.flatMap((s) => s.evidenceIds))].sort(),
    },
    subSpecialty: { labels: [], confidence: null, evidenceIds: [] },
    brand: {
      labels: (profile.brands ?? [])
        .filter((b) => b.availability !== 'UNAVAILABLE' && b.evidenceIds.length > 0)
        .map((b) => snapshotLabels.get(b.value) ?? b.value),
      confidence:
        (profile.brands ?? []).length === 0
          ? null
          : (profile.brands ?? []).reduce((sum, b) => sum + b.confidence, 0) / (profile.brands ?? []).length,
      evidenceIds: [...new Set((profile.brands ?? []).flatMap((b) => b.evidenceIds))].sort(),
    },
    location:
      profile.city === undefined || profile.city.availability === 'UNAVAILABLE' || profile.city.evidenceIds.length === 0
        ? { labels: [], confidence: null, evidenceIds: [] }
        : { labels: [profile.city.value], confidence: profile.city.confidence, evidenceIds: [...profile.city.evidenceIds].sort() },
  };
}

export function answerFromRules(rules: RulesAnswer): ArmAnswer {
  const from = (
    r: { label: string; confidence: number; evidenceIds: string[] } | null,
  ): Prediction =>
    r === null
      ? { labels: [], confidence: null, evidenceIds: [] }
      : { labels: [r.label], confidence: r.confidence, evidenceIds: [...r.evidenceIds] };
  return {
    businessType: from(rules.businessType),
    industry: from(rules.industry),
    specialty: {
      labels: rules.specialty.map((s) => s.label),
      confidence: rules.specialty.length === 0 ? null : rules.specialty[0]?.confidence ?? null,
      evidenceIds: [...new Set(rules.specialty.flatMap((s) => s.evidenceIds))].sort(),
    },
    subSpecialty: {
      labels: rules.subSpecialty.map((s) => s.label),
      confidence: rules.subSpecialty.length === 0 ? null : rules.subSpecialty[0]?.confidence ?? null,
      evidenceIds: [...new Set(rules.subSpecialty.flatMap((s) => s.evidenceIds))].sort(),
    },
    brand: {
      labels: rules.brand.map((b) => b.label),
      confidence: rules.brand.length === 0 ? null : rules.brand[0]?.confidence ?? null,
      evidenceIds: [...new Set(rules.brand.flatMap((b) => b.evidenceIds))].sort(),
    },
    location: from(rules.city),
  };
}

/**
 * RULES_THEN_LLM: LLM labels first, deterministic rules only fill dimensions
 * the LLM left empty (never overrides a claimed LLM label).
 */
export function mergeRulesThenLlm(llm: ArmAnswer, rules: ArmAnswer): ArmAnswer {
  const pick = (llmP: Prediction, ruleP: Prediction): Prediction =>
    llmP.labels.length > 0 ? llmP : ruleP;
  return {
    businessType: pick(llm.businessType, rules.businessType),
    industry: pick(llm.industry, rules.industry),
    specialty: pick(llm.specialty, rules.specialty),
    subSpecialty: pick(llm.subSpecialty, rules.subSpecialty),
    brand: pick(llm.brand, rules.brand),
    location: pick(llm.location, rules.location),
  };
}

// ---------------------------------------------------------------------------
// Availability of arms
// ---------------------------------------------------------------------------

/** Which arms can execute given the configured providers. */
export function armAvailability(options: {
  llmReady: boolean;
  decisionReady: boolean;
}): EvalArmAvailability[] {
  return EVAL_ARM_IDS.map((arm) => {
    switch (arm) {
      case 'RULES_ONLY':
        return { arm, status: 'EXECUTED' as const };
      case 'LLM_ONLY':
      case 'RULES_THEN_LLM':
        return options.llmReady
          ? { arm, status: 'EXECUTED' as const }
          : { arm, status: 'NOT_CONFIGURED' as const, reason: 'no LLM provider configured (AI_PROVIDER)' };
      case 'LLM_THEN_DECISION_PROVIDER':
        if (!options.llmReady) {
          return { arm, status: 'NOT_CONFIGURED' as const, reason: 'no LLM provider configured (AI_PROVIDER)' };
        }
        if (!options.decisionReady) {
          return { arm, status: 'NOT_CONFIGURED' as const, reason: 'no DecisionProvider (Jev) configured — arm intentionally unimplemented (ADR-017)' };
        }
        return { arm, status: 'EXECUTED' as const };
      case 'RULES_LLM_DECISION_PROVIDER':
        if (!options.decisionReady) {
          return { arm, status: 'NOT_CONFIGURED' as const, reason: 'no DecisionProvider (Jev) configured — arm intentionally unimplemented (ADR-017)' };
        }
        return { arm, status: 'EXECUTED' as const };
      default:
        return { arm, status: 'FAILED' as const, reason: 'unknown arm' };
    }
  });
}

/** Runs the LLM extraction for one case (shared by LLM-containing arms). */
export async function runLlmExtraction(
  llm: LLMProvider,
  input: ProfileExtractionInput,
): Promise<ExtractionResult> {
  return llm.extractStructuredProfile({ ...input, taxonomySnapshot: input.taxonomySnapshot });
}

export { EVAL_ARM_IDS };
