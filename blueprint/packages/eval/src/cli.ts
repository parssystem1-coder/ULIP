/**
 * Evaluation CLI (Phase 17 §10, §11) — `pnpm eval`.
 *
 * Runs the executable arms over the committed dataset, persists runs (when a
 * database is reachable), compares against the baseline and enforces the
 * release gate. Provider selection is EXPLICIT:
 *   default          → deterministic fake provider (no network, no cost)
 *   ULIP_EVAL_LIVE=1 → the configured HTTP provider (requires AI_BASE_URL/key)
 * A Jev/DecisionProvider does not exist yet → Jev arms are recorded
 * NOT_CONFIGURED (ADR-017), never fabricated.
 *
 * Flags:
 *   --arm <ID>        run a single arm (default: all executable arms)
 *   --no-db           skip persistence even when ULIP_PG_URL is set
 *   --write-baseline  persist the first run per arm as the new baseline file
 *   --stable          zero timestamps in the baseline file (byte-stable artifact)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '@ulip/runtime';
import { selectAiRuntime, loadAiConfig } from '@ulip/ai';
import type { LLMProvider } from '@ulip/ai';
import type { EvalArmId, EvalRunRecord } from './contracts.ts';
import { EVAL_ARM_IDS } from './contracts.ts';
import { loadDefaultDataset } from './dataset.ts';
import { runEvaluationDetailed } from './runner.ts';
import { compareRuns, renderRegressionReport } from './regression.ts';
import { DbEvalStore } from './store.ts';
import { renderRunReport, summarizeRun } from './report.ts';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_DIR = join(PACKAGE_ROOT, 'baselines');

const STABLE_TS = '1970-01-01T00:00:00.000Z';

function parseArgs(argv: readonly string[]): {
  arm?: string | undefined;
  noDb: boolean;
  writeBaseline: boolean;
  stable: boolean;
} {
  const args = [...argv];
  let arm: string | undefined;
  let noDb = false;
  let writeBaseline = false;
  let stable = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--arm') {
      arm = args[i + 1];
      i += 1;
    } else if (a === '--no-db') noDb = true;
    else if (a === '--write-baseline') writeBaseline = true;
    else if (a === '--stable') stable = true;
  }
  return { arm, noDb, writeBaseline, stable };
}

function resolveProvider(): { llm: LLMProvider | null; source: string } {
  const liveRequested = process.env['ULIP_EVAL_LIVE'] === '1';
  const runtime = selectAiRuntime(loadAiConfig(process.env));
  if (liveRequested) {
    if (runtime.status === 'READY' && runtime.llm !== null && runtime.meta.kind === 'HTTP') {
      return { llm: runtime.llm, source: `live HTTP provider ${runtime.meta.provider}/${runtime.meta.modelVersion}` };
    }
    console.warn('ULIP_EVAL_LIVE=1 but no HTTP AI provider is configured — falling back to the deterministic fake provider.');
  }
  // Deterministic fake: never selected silently in production CLI runs.
  if (runtime.status === 'READY' && runtime.llm !== null && runtime.meta.kind === 'FAKE') {
    return { llm: runtime.llm, source: 'deterministic fake provider' };
  }
  const fake = selectAiRuntime(loadAiConfig({ ...process.env, AI_PROVIDER: 'fake', NODE_ENV: 'test' }), { allowFake: true });
  if (fake.status === 'READY' && fake.llm !== null) return { llm: fake.llm, source: 'deterministic fake provider (forced)' };
  return { llm: null, source: 'none' };
}

function baselinePath(arm: string): string {
  return join(BASELINE_DIR, `baseline-${arm.toLowerCase()}-v1.json`);
}

function loadBaseline(arm: string): EvalRunRecord | null {
  const p = baselinePath(arm);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { record: EvalRunRecord };
    return parsed.record;
  } catch {
    return null;
  }
}

function writeBaseline(run: EvalRunRecord, stable: boolean): void {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const record: EvalRunRecord = stable
    ? { ...run, startedAt: STABLE_TS, finishedAt: STABLE_TS }
    : run;
  writeFileSync(
    baselinePath(run.arm),
    `${JSON.stringify({ baseline: true, record }, null, 2)}\n`,
  );
}

async function openDb(): Promise<{ db: Database; store: DbEvalStore } | null> {
  const url = process.env['ULIP_PG_URL'] ?? process.env['DATABASE_URL'];
  if (url === undefined || url === '') return null;
  try {
    const db = new Database({ connectionString: url, max: 4 });
    await db.query('SELECT 1');
    return { db, store: new DbEvalStore(db) };
  } catch (err) {
    console.warn(`database unreachable, runs will not be persisted: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dataset = loadDefaultDataset();
  const { llm, source } = resolveProvider();
  console.log(`eval: dataset ${dataset.datasetVersion} (${dataset.cases.length} cases), provider: ${source}`);

  const arms = args.arm !== undefined ? [args.arm as EvalArmId] : [...EVAL_ARM_IDS];
  for (const arm of arms) {
    if (!(EVAL_ARM_IDS as readonly string[]).includes(arm)) {
      console.error(`unknown arm: ${arm}`);
      return 2;
    }
  }

  const connection = args.noDb ? null : await openDb();
  let blocked = false;

  for (const arm of arms) {
    const { record: run, results } = await runEvaluationDetailed({ dataset, arm, llm });
    console.log('');
    console.log(summarizeRun(run));
    if (run.armStatus === 'EXECUTED') {
      console.log(renderRunReport(run));
    }

    let baseline = connection !== null ? await connection.store.findBaselineRun(run.tenantId, run) : null;
    if (baseline === null) baseline = loadBaseline(arm);
    if (args.writeBaseline && run.armStatus === 'EXECUTED') {
      // Regenerating replaces the committed baseline (explicit opt-in).
      writeBaseline(run, args.stable);
      console.log(`baseline written: ${baselinePath(arm)}`);
    } else if (baseline !== null && run.armStatus === 'EXECUTED') {
      const report = compareRuns(baseline, run);
      console.log('');
      console.log(renderRegressionReport(report));
      if (report.hasRegressions) blocked = true;
    }

    if (connection !== null) {
      await connection.store.persistRun(run, results);
      console.log(`persisted run ${run.runId} (${run.armStatus}, ${results.length} case results)`);
    }
  }

  if (connection !== null) await connection.db.close();
  return blocked ? 1 : 0;
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? '#');
if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
