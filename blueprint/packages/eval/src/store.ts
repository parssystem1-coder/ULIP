/**
 * Persistence for evaluation runs (Phase 17 §3, §12, §13, §15).
 *
 * Writes to the 0004_evaluation tables ONLY — ai_runs is untouched (evaluation
 * is a measurement over a frozen dataset, not a provider call). Runs are
 * immutable historical facts (DB trigger enforced); corrections are separate
 * append-only rows that never overwrite AI output; the feedback exporter turns
 * corrections into a future human-labeled dataset draft (§13).
 */

import type { Database } from '@ulip/runtime';
import { deterministicUuid } from '@ulip/analysis';
import type {
  EvalCase,
  EvalCaseResult,
  EvalDataset,
  EvalErrorCategory,
  EvalDimension,
  EvalRunRecord,
} from './contracts.ts';
import { EVAL_ERROR_CATEGORIES, EVAL_DIMENSIONS } from './contracts.ts';

interface RunRow {
  id: string;
  tenant_id: string;
  dataset_version: string;
  arm: string;
  arm_status: string;
  arm_reason: string | null;
  provider: string;
  model: string;
  prompt_version: string;
  schema_version: string;
  taxonomy_version: number;
  scoring_policy_version: string;
  started_at: Date | string;
  finished_at: Date | string;
  total_cases: number;
  metrics: EvalRunRecord['metrics'];
}

function toIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}

/** A feedback-draft case: the original case plus the applied human corrections. */
export interface FeedbackCase extends EvalCase {
  correctionsApplied?: { field: string; from: unknown; to: unknown }[];
}

/** The §13 export: a dataset-shaped draft for the next human labeling round. */
export interface FeedbackDataset extends Omit<EvalDataset, 'cases'> {
  cases: FeedbackCase[];
}

function rowToRun(row: RunRow): EvalRunRecord {
  return {
    runId: row.id,
    tenantId: row.tenant_id,
    versions: {
      datasetVersion: row.dataset_version,
      provider: row.provider,
      model: row.model,
      promptVersion: row.prompt_version,
      schemaVersion: row.schema_version,
      taxonomyVersion: row.taxonomy_version,
      scoringPolicyVersion: row.scoring_policy_version,
    },
    arm: row.arm as EvalRunRecord['arm'],
    armStatus: row.arm_status as EvalRunRecord['armStatus'],
    armReason: row.arm_reason,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    metrics: row.metrics,
  };
}

export class DbEvalStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Persists a run idempotently (deterministic run id → ON CONFLICT DO NOTHING). */
  async persistRun(run: EvalRunRecord, results: readonly EvalCaseResult[]): Promise<{ persisted: boolean }> {
    return this.db.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO evaluation_runs
           (id, tenant_id, dataset_version, arm, arm_status, arm_reason,
            provider, model, prompt_version, schema_version, taxonomy_version,
            scoring_policy_version, started_at, finished_at, total_cases, metrics)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
         ON CONFLICT (tenant_id, dataset_version, arm, provider, model,
                      prompt_version, schema_version, taxonomy_version, scoring_policy_version)
         DO NOTHING
         RETURNING id`,
        [
          run.runId,
          run.tenantId,
          run.versions.datasetVersion,
          run.arm,
          run.armStatus,
          run.armReason,
          run.versions.provider,
          run.versions.model,
          run.versions.promptVersion,
          run.versions.schemaVersion,
          run.versions.taxonomyVersion,
          run.versions.scoringPolicyVersion,
          run.startedAt,
          run.finishedAt,
          run.metrics.totalCases,
          JSON.stringify(run.metrics),
        ],
      );
      if (inserted.rows[0] === undefined) return { persisted: false };

      for (const r of results) {
        await client.query(
          `INSERT INTO evaluation_case_results
             (run_id, tenant_id, case_id, exact_match, dimension_accuracy, mean_confidence,
              error_category, outcome, outcome_expected, outcome_correct,
              latency_ms, tokens_input, tokens_output, estimated_cost, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
          [
            run.runId,
            run.tenantId,
            r.caseId,
            r.exactMatch,
            r.dimensionAccuracy,
            r.meanConfidence,
            r.errorCategory,
            r.reviewOutcome.actual,
            r.reviewOutcome.expected,
            r.reviewOutcome.expected !== null ? r.reviewOutcome.correct : null,
            Math.round(r.latencyMs),
            r.tokens?.input ?? null,
            r.tokens?.output ?? null,
            r.estimatedCost,
            JSON.stringify({
              outcomes: r.outcomes,
              scores: r.scores,
              miscalibrated: r.miscalibrated,
              errorDetail: r.errorDetail,
            }),
          ],
        );
      }
      return { persisted: true };
    });
  }

  async findRun(tenantId: string, runId: string): Promise<EvalRunRecord | null> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM evaluation_runs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runId],
    );
    const row = r.rows[0];
    return row === undefined ? null : rowToRun(row);
  }

  /** Latest runs for a tenant, newest first. */
  async listRuns(tenantId: string, limit = 20): Promise<EvalRunRecord[]> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM evaluation_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return r.rows.map(rowToRun);
  }

  /**
   * Resolves the regression baseline: the most recent EXECUTED run for the
   * same dataset version + arm with a DIFFERENT version tuple is preferred;
   * otherwise the previous run of the same tuple.
   */
  async findBaselineRun(tenantId: string, current: EvalRunRecord): Promise<EvalRunRecord | null> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM evaluation_runs
       WHERE tenant_id = $1 AND arm = $2 AND id <> $3 AND arm_status = 'EXECUTED'
         AND dataset_version = $4
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, current.arm, current.runId, current.versions.datasetVersion],
    );
    const row = r.rows[0];
    return row === undefined ? null : rowToRun(row);
  }

  async listCaseResults(tenantId: string, runId: string, limit = 500): Promise<
    { caseId: string; exactMatch: boolean; dimensionAccuracy: number; meanConfidence: number | null; errorCategory: string | null; outcome: string | null; outcomeExpected: string | null; outcomeCorrect: boolean | null; latencyMs: number; tokensInput: number | null; tokensOutput: number | null; estimatedCost: string | null; detail: Record<string, unknown> }[]
  > {
    const r = await this.db.query<{
      case_id: string;
      exact_match: boolean;
      dimension_accuracy: string;
      mean_confidence: string | null;
      error_category: string | null;
      outcome: string | null;
      outcome_expected: string | null;
      outcome_correct: boolean | null;
      latency_ms: number;
      tokens_input: number | null;
      tokens_output: number | null;
      estimated_cost: string | null;
      detail: Record<string, unknown>;
    }>(
      `SELECT case_id, exact_match, dimension_accuracy, mean_confidence, error_category,
              outcome, outcome_expected, outcome_correct, latency_ms,
              tokens_input, tokens_output, estimated_cost, detail
       FROM evaluation_case_results
       WHERE tenant_id = $1 AND run_id = $2
       ORDER BY case_id
       LIMIT $3`,
      [tenantId, runId, limit],
    );
    return r.rows.map((row) => ({
      caseId: row.case_id,
      exactMatch: row.exact_match,
      dimensionAccuracy: Number(row.dimension_accuracy),
      meanConfidence: row.mean_confidence === null ? null : Number(row.mean_confidence),
      errorCategory: row.error_category,
      outcome: row.outcome,
      outcomeExpected: row.outcome_expected,
      outcomeCorrect: row.outcome_correct,
      latencyMs: row.latency_ms,
      tokensInput: row.tokens_input,
      tokensOutput: row.tokens_output,
      estimatedCost: row.estimated_cost,
      detail: row.detail,
    }));
  }

  /** Appends a human correction (§12). Never touches AI output rows. */
  async addCorrection(input: {
    tenantId: string;
    runId: string | null;
    caseId: string;
    datasetVersion: string;
    field: 'businessType' | 'industry' | 'specialty' | 'subSpecialty' | 'brand' | 'location' | 'outcome' | 'score';
    originalValue: unknown;
    correctedValue: unknown;
    reviewerId?: string | undefined;
    reviewerNote?: string | undefined;
  }): Promise<{ id: string }> {
    const id = deterministicUuid(
      'eval-correction',
      input.tenantId,
      input.datasetVersion,
      input.caseId,
      input.field,
      String(input.correctedValue),
      String(Date.now()),
    );
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO evaluation_corrections
         (id, tenant_id, run_id, case_id, dataset_version, field,
          original_value, corrected_value, reviewer_id, reviewer_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)
       RETURNING id`,
      [
        id,
        input.tenantId,
        input.runId,
        input.caseId,
        input.datasetVersion,
        input.field,
        JSON.stringify(input.originalValue ?? null),
        JSON.stringify(input.correctedValue),
        input.reviewerId ?? null,
        input.reviewerNote ?? null,
      ],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error('correction insert failed');
    return { id: row.id };
  }

  async listCorrections(tenantId: string, datasetVersion?: string): Promise<
    { id: string; caseId: string; datasetVersion: string; field: string; originalValue: unknown; correctedValue: unknown; reviewerId: string | null; reviewerNote: string | null; createdAt: string }[]
  > {
    const where = datasetVersion !== undefined
      ? `WHERE tenant_id = $1 AND dataset_version = $2`
      : `WHERE tenant_id = $1`;
    const params = datasetVersion !== undefined ? [tenantId, datasetVersion] : [tenantId];
    const r = await this.db.query<{
      id: string;
      case_id: string;
      dataset_version: string;
      field: string;
      original_value: unknown;
      corrected_value: unknown;
      reviewer_id: string | null;
      reviewer_note: string | null;
      created_at: Date | string;
    }>(
      `SELECT id, case_id, dataset_version, field, original_value, corrected_value,
              reviewer_id, reviewer_note, created_at
       FROM evaluation_corrections ${where}
       ORDER BY created_at DESC
       LIMIT 1000`,
      params,
    );
    return r.rows.map((row) => ({
      id: row.id,
      caseId: row.case_id,
      datasetVersion: row.dataset_version,
      field: row.field,
      originalValue: row.original_value,
      correctedValue: row.corrected_value,
      reviewerId: row.reviewer_id,
      reviewerNote: row.reviewer_note,
      createdAt: toIso(row.created_at),
    }));
  }

  /**
   * Feedback dataset export (§13): starts from the CURRENT dataset and applies
   * human corrections on top. Corrections are data, not training — the result
   * is a draft of the next human-labeled dataset version for human review.
   */
  exportFeedbackDataset(
    baseDataset: EvalDataset,
    corrections: readonly {
      caseId: string;
      field: string;
      originalValue: unknown;
      correctedValue: unknown;
      reviewerNote: string | null;
    }[],
  ): FeedbackDataset {
    const byCase = new Map<string, { field: string; correctedValue: unknown; originalValue: unknown; note: string | null }[]>();
    for (const c of corrections) {
      const list = byCase.get(c.caseId) ?? [];
      list.push({ field: c.field, correctedValue: c.correctedValue, originalValue: c.originalValue, note: c.reviewerNote });
      byCase.set(c.caseId, list);
    }
    const [major, minor] = baseDataset.datasetVersion.split('.');
    const nextVersion = `${major}.${Number(minor ?? 0) + 1}.0-draft`;
    const cases: FeedbackCase[] = baseDataset.cases.map((c) => {
      const changes = byCase.get(c.caseId);
      const base: EvalCase = {
        ...c,
        expected: {
          businessType: c.expected.businessType,
          industry: c.expected.industry,
          specialty: [...c.expected.specialty],
          subSpecialty: [...c.expected.subSpecialty],
          brand: [...c.expected.brand],
          location: c.expected.location,
        },
      };
      if (changes === undefined) return base;
      const out: FeedbackCase = { ...base };
      const applied: { field: string; from: unknown; to: unknown }[] = [];
      for (const change of changes) {
        if (change.field === 'outcome') {
          if (change.correctedValue === 'QUALIFIED' || change.correctedValue === 'REVIEW_REQUIRED' || change.correctedValue === 'REJECTED') {
            out.expectedOutcome = change.correctedValue;
            applied.push({ field: change.field, from: c.expectedOutcome ?? null, to: change.correctedValue });
          }
          continue;
        }
        if (change.field === 'score') continue; // score corrections annotate, never relabel
        const key = change.field as keyof EvalCase['expected'];
        const from = base.expected[key];
        applied.push({ field: change.field, from, to: change.correctedValue });
        if (key === 'specialty' || key === 'subSpecialty' || key === 'brand') {
          if (Array.isArray(change.correctedValue)) out.expected[key] = change.correctedValue as string[];
        } else {
          if (change.correctedValue === null || typeof change.correctedValue === 'string') {
            out.expected[key] = change.correctedValue;
          }
        }
      }
      if (applied.length > 0) out.correctionsApplied = applied;
      return out;
    });
    return {
      datasetVersion: nextVersion,
      provenance: `Draft exported from human corrections over dataset ${baseDataset.datasetVersion}. Requires human review before becoming a labeled dataset version.`,
      taxonomySnapshot: baseDataset.taxonomySnapshot,
      taxonomyVersion: baseDataset.taxonomyVersion,
      taxonomyAliases: baseDataset.taxonomyAliases,
      locationAliases: baseDataset.locationAliases,
      cases,
    };
  }
}

export { EVAL_ERROR_CATEGORIES, EVAL_DIMENSIONS };
