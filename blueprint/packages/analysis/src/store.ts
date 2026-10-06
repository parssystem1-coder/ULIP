import type { Database } from '@ulip/runtime';
import type { AnalysisMode } from '@ulip/domain/contracts';
import type {
  AnalysisRecordDraft,
  AnalysisStore,
  EvidenceDraft,
  LeadContext,
  PersistRunInput,
  PersistRunResult,
} from './contracts.ts';
import { loadLeadContext } from './load-context.ts';

/**
 * PostgreSQL implementation of the analysis store (ADR-024 current-version
 * semantics). All result rows for one run are committed in ONE transaction:
 * analysis + evidence link + classifications + scores + ai_run. Historical
 * rows are never deleted — they are superseded (is_current=false,
 * superseded_at set), and the partial unique indexes guarantee exactly one
 * current analysis and one current score per lead.
 */
export class DbAnalysisStore implements AnalysisStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async loadContext(tenantId: string, leadId: string, analysisMode: AnalysisMode): Promise<LeadContext | null> {
    const ctx = await loadLeadContext(this.db, tenantId, leadId);
    return ctx === null ? null : { ...ctx, analysisMode };
  }

  async hasSuccessfulRun(jobId: string, leadId: string): Promise<boolean> {
    const r = await this.db.query<{ id: string }>(
      `SELECT id FROM ai_runs WHERE job_id = $1 AND lead_id = $2 AND status = 'SUCCESS' LIMIT 1`,
      [jobId, leadId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Evidence-first: rows exist before the model is called (idempotent). */
  async persistEvidence(drafts: EvidenceDraft[]): Promise<number> {
    let inserted = 0;
    for (const d of drafts) {
      const r = await this.db.query(
        `INSERT INTO evidence
           (id, lead_id, analysis_id, evidence_type, source_type, source_reference,
            content, content_hash, retrieved_at, metadata, confidence)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          d.id, d.leadId, d.evidenceType, d.sourceType, d.sourceReference,
          d.content, d.contentHash, d.retrievedAt, JSON.stringify(d.metadata), d.confidence,
        ],
      );
      inserted += r.rowCount ?? 0;
    }
    return inserted;
  }

  async persistRun(run: PersistRunInput): Promise<PersistRunResult> {
    return this.db.transaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM lead_analyses WHERE id = $1',
        [run.analysis.id],
      );
      const firstPersist = (existing.rowCount ?? 0) === 0;

      let supersededAnalysisId: string | null = null;
      if (firstPersist) {
        const sup = await client.query<{ id: string }>(
          `UPDATE lead_analyses SET is_current = FALSE, superseded_at = now()
           WHERE lead_id = $1 AND is_current = TRUE RETURNING id`,
          [run.leadId],
        );
        supersededAnalysisId = sup.rows[0]?.id ?? null;
        await client.query(
          `INSERT INTO lead_analyses
             (id, lead_id, analysis_version, model_version, prompt_version, schema_version,
              taxonomy_version, analysis_mode, summary, structured_output, confidence, is_current)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::analysis_mode, $9, $10::jsonb, $11, TRUE)`,
          [
            run.analysis.id, run.leadId, run.analysis.analysisVersion, run.analysis.modelVersion,
            run.analysis.promptVersion, run.analysis.schemaVersion, run.analysis.taxonomyVersion,
            run.analysis.analysisMode, run.analysis.summary,
            JSON.stringify(run.analysis.structuredOutput), run.analysis.confidence,
          ],
        );
      }

      let evidenceLinked = 0;
      if (run.evidenceIds.length > 0) {
        const link = await client.query(
          `UPDATE evidence SET analysis_id = $1
           WHERE lead_id = $2 AND id = ANY($3::uuid[]) AND analysis_id IS NULL`,
          [run.analysis.id, run.leadId, run.evidenceIds],
        );
        evidenceLinked = link.rowCount ?? 0;
      }

      let classificationsInserted = 0;
      if (firstPersist) {
        for (const c of run.classifications) {
          const ins = await client.query(
            `INSERT INTO lead_classifications
               (lead_id, analysis_id, classification_type, taxonomy_node_id, value_text,
                value_normalized, confidence, source, model_version)
             VALUES ($1, $2, $3::classification_type, $4, $5, $6, $7, $8, $9)`,
            [
              run.leadId, run.analysis.id, c.classificationType, c.taxonomyNodeId,
              c.valueText, c.valueNormalized, c.confidence, c.source, c.modelVersion,
            ],
          );
          classificationsInserted += ins.rowCount ?? 0;
        }
        await this.applyBusinessModel(client, run);
      }

      const supScore = await client.query<{ id: string }>(
        `UPDATE lead_scores SET is_current = FALSE, superseded_at = now()
         WHERE lead_id = $1 AND is_current = TRUE AND id <> $2 RETURNING id`,
        [run.leadId, run.score.id],
      );
      const supersededScoreId = supScore.rows[0]?.id ?? null;
      await client.query(
        `INSERT INTO lead_scores
           (id, lead_id, scoring_policy_version_id, relevance_score, audience_quality_score,
            activity_score, confidence_score, priority_score, is_current)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [
          run.score.id, run.leadId, run.score.scoringPolicyVersionId, run.score.relevance,
          run.score.audienceQuality, run.score.activity, run.score.confidence, run.score.priority,
        ],
      );

      const aq = run.audienceQuality;
      await client.query(
        `INSERT INTO audience_quality
           (id, lead_id, quality_score, risk_level, signals, confidence, model_version)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [aq.id, run.leadId, aq.qualityScore, aq.riskLevel, JSON.stringify(aq.signals), aq.confidence, aq.modelVersion],
      );

      const providerRef = await this.resolveProvider(client, run);
      await client.query(
        `INSERT INTO ai_runs
           (id, tenant_id, lead_id, job_id, provider_id, model_version_id, task_type,
            analysis_mode, input_hash, output_hash, status, latency_ms, prompt_version,
            schema_version, error)
         VALUES ($1, $2, $3, $4, $5, $6, 'EXTRACTION', $7::analysis_mode, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO NOTHING`,
        [
          run.aiRun.id, run.tenantId, run.leadId, run.jobId, providerRef.id, providerRef.modelVersionId,
          run.analysis.analysisMode, run.aiRun.inputHash, run.aiRun.outputHash, run.aiRun.status,
          run.aiRun.latencyMs, run.aiRun.promptVersion, run.aiRun.schemaVersion, run.aiRun.error ?? null,
        ],
      );

      return {
        analysisId: run.analysis.id,
        scoreId: run.score.id,
        evidenceLinked,
        classificationsInserted,
        supersededAnalysisId,
        supersededScoreId,
      };
    });
  }

  /** Non-destructive: fills the business model only where it is still empty. */
  private async applyBusinessModel(
    client: { query(q: string, v?: readonly unknown[]): Promise<{ rowCount: number | null }> },
    run: PersistRunInput,
  ): Promise<void> {
    const bt = run.classifications.find(
      (c) => c.classificationType === 'BUSINESS_TYPE' && c.taxonomyNodeId !== null,
    );
    const ind = run.classifications.find(
      (c) => c.classificationType === 'INDUSTRY' && c.taxonomyNodeId !== null,
    );
    if (bt !== undefined) {
      await client.query(
        `UPDATE businesses SET business_type_node_id = $2
         WHERE id = (SELECT business_id FROM leads WHERE id = $1)
           AND business_type_node_id IS NULL`,
        [run.leadId, bt.taxonomyNodeId],
      );
    }
    if (ind !== undefined) {
      await client.query(
        `UPDATE businesses SET industry_node_id = $2
         WHERE id = (SELECT business_id FROM leads WHERE id = $1)
           AND industry_node_id IS NULL`,
        [run.leadId, ind.taxonomyNodeId],
      );
    }
  }

  private async resolveProvider(
    client: { query(q: string, v?: readonly unknown[]): Promise<{ rows: { id: string }[] }> },
    run: PersistRunInput,
  ): Promise<{ id: string; modelVersionId: string | null }> {
    const provider = await client.query(
      `INSERT INTO ai_providers (name, type, config)
       VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (name) DO UPDATE SET config = ai_providers.config
       RETURNING id`,
      [run.aiRun.provider, run.aiRun.providerType],
    );
    const providerId = provider.rows[0]?.id;
    if (providerId === undefined) throw new Error('failed to resolve ai_providers row');
    const model = await client.query(
      `INSERT INTO model_versions (provider_id, name, version, capabilities)
       VALUES ($1, $2, $3, '[]'::jsonb)
       ON CONFLICT (provider_id, name, version) DO UPDATE SET status = 'ACTIVE'
       RETURNING id`,
      [providerId, run.aiRun.model, run.aiRun.schemaVersion],
    );
    return { id: providerId, modelVersionId: model.rows[0]?.id ?? null };
  }
}
