import type { Database } from '@ulip/runtime';
import {
  resolvePolicy,
  validateWeights,
  type PolicyThresholds,
  type PolicyWeights,
  type ResolvedScoringPolicy,
  type ScoringPolicyVersionRow,
} from '@ulip/scoring';
import type { AnalysisPolicyService } from './contracts.ts';

export class ScoringPolicyNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`no ACTIVE scoring policy version for tenant ${tenantId}`);
    this.name = 'ScoringPolicyNotFoundError';
  }
}

/**
 * Bootstrap default — identical to database/seeds/002_policies_example.sql.
 * It is INSERTED into scoring_policies/scoring_policy_versions (versioned,
 * auditable, editable) and then resolved through the normal policy mechanism;
 * no threshold is ever read from application code at scoring time.
 */
export const BOOTSTRAP_SCORING_POLICY = {
  name: 'default',
  description: 'Default scoring policy (bootstrapped on first analysis)',
  weights: { relevance: 0.4, audienceQuality: 0.2, activity: 0.25, confidence: 0.15 } as PolicyWeights,
  thresholds: { qualifiedMin: 80, reviewMin: 60, rejectMax: 40 } as PolicyThresholds,
};

interface PolicyRow {
  id: string;
  policy_id: string;
  version: number;
  weights: PolicyWeights;
  thresholds: PolicyThresholds;
  status: string;
  effective_from: string;
  effective_to: string | null;
}

export class DbScoringPolicyResolver implements AnalysisPolicyService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  private async rows(tenantId: string): Promise<ScoringPolicyVersionRow[]> {
    const r = await this.db.query<PolicyRow>(
      `SELECT v.id, v.policy_id, v.version, v.weights, v.thresholds,
              v.status::text AS status, v.effective_from, v.effective_to
       FROM scoring_policy_versions v
       JOIN scoring_policies p ON p.id = v.policy_id
       WHERE p.tenant_id = $1`,
      [tenantId],
    );
    return r.rows.map((row) => ({
      id: row.id,
      policyId: row.policy_id,
      version: row.version,
      weights: row.weights,
      thresholds: row.thresholds,
      status: row.status === 'RETIRED' ? 'RETIRED' : 'ACTIVE',
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    }));
  }

  async resolve(tenantId: string): Promise<ResolvedScoringPolicy> {
    const resolved = resolvePolicy(await this.rows(tenantId));
    if (resolved === null) throw new ScoringPolicyNotFoundError(tenantId);
    return resolved;
  }

  /** Resolves, creating the documented default policy once when absent. */
  async resolveOrBootstrap(tenantId: string): Promise<ResolvedScoringPolicy> {
    try {
      return await this.resolve(tenantId);
    } catch (err) {
      if (!(err instanceof ScoringPolicyNotFoundError)) throw err;
    }

    const policy = await this.db.query<{ id: string }>(
      `INSERT INTO scoring_policies (tenant_id, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [tenantId, BOOTSTRAP_SCORING_POLICY.name, BOOTSTRAP_SCORING_POLICY.description],
    );
    const policyId = policy.rows[0]?.id;
    if (policyId === undefined) throw new ScoringPolicyNotFoundError(tenantId);

    // Validate the bootstrap values before they become policy truth.
    const weightsCheck = validateWeights(BOOTSTRAP_SCORING_POLICY.weights);
    if (!weightsCheck.ok) throw new Error(`bootstrap weights invalid: ${weightsCheck.errors.join(', ')}`);

    await this.db.query(
      `INSERT INTO scoring_policy_versions (policy_id, version, weights, thresholds, status, effective_from)
       VALUES ($1, 1, $2::jsonb, $3::jsonb, 'ACTIVE', now())
       ON CONFLICT (policy_id, version) DO NOTHING`,
      [policyId, JSON.stringify(BOOTSTRAP_SCORING_POLICY.weights), JSON.stringify(BOOTSTRAP_SCORING_POLICY.thresholds)],
    );

    const resolved = resolvePolicy(await this.rows(tenantId));
    if (resolved === null) throw new ScoringPolicyNotFoundError(tenantId);
    return resolved;
  }
}
