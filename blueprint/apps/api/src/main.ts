/**
 * ULIP API bootstrap (Phase 14).
 *
 * Startup order: validate env → compose → routes → listen. /health and
 * /ready are public; everything else requires an API key and resolves the
 * tenant context from it. Graceful shutdown closes the pool.
 */

import { createServer, type Server } from 'node:http';
import { compose, type AppContext } from './composer.ts';
import {
  bootstrapHandler,
  createCampaign,
  createDiscovery,
  createJob,
  createLead,
  createSource,
  createTaxonomy,
  addEvaluationCorrection,
  exportEvaluationFeedbackDataset,
  getDiscoveryJob,
  getEvaluationRun,
  getEvaluationRunRegression,
  getJob,
  getLead,
  getLeadAnalysis,
  getLeadEvidence,
  getLeadScores,
  healthHandler,
  listCampaigns,
  listEvaluationCorrections,
  listEvaluationRuns,
  listJobs,
  listLeads,
  listSources,
  listTaxonomy,
  readyHandler,
  reprocessLead,
} from './controllers.ts';
import { readJsonBody, readQuery } from './http.ts';
import { pipeline, Router } from './middleware.ts';

export async function createApiServer(app: AppContext): Promise<Server> {
  const router = new Router();

  // system
  router.add('GET', '/health', healthHandler(app), { public: true });
  router.add('GET', '/ready', readyHandler(app), { public: true });
  router.add('POST', '/internal/bootstrap', bootstrapHandler(app), { public: true });

  // sources
  router.add('GET', '/sources', listSources(app));
  router.add('POST', '/sources', createSource(app));

  // taxonomy
  router.add('GET', '/taxonomy', listTaxonomy(app));
  router.add('POST', '/taxonomy', createTaxonomy(app));

  // leads
  router.add('GET', '/leads', listLeads(app));
  router.add('POST', '/leads', createLead(app));

  // lead analysis (Phase 16, ADR-028) — OPENAPI.yaml /leads/{leadId}/...
  router.add('GET', '/leads/:leadId', getLead(app));
  router.add('GET', '/leads/:leadId/analysis', getLeadAnalysis(app));
  router.add('GET', '/leads/:leadId/evidence', getLeadEvidence(app));
  router.add('GET', '/leads/:leadId/scores', getLeadScores(app));
  router.add('POST', '/leads/:leadId/reprocess', reprocessLead(app));

  // campaigns
  router.add('GET', '/campaigns', listCampaigns(app));
  router.add('POST', '/campaigns', createCampaign(app));

  // jobs
  router.add('GET', '/jobs', listJobs(app));
  router.add('POST', '/jobs', createJob(app));
  router.add('GET', '/jobs/:jobId', getJob(app));

  // discovery (Phase 15, ADR-027) — OPENAPI.yaml /discovery/*
  router.add('POST', '/discovery/search', createDiscovery(app));
  router.add('GET', '/discovery/jobs/:jobId', getDiscoveryJob(app));

  // evaluation (Phase 17, ADR-029) — OPENAPI.yaml /evaluation/*
  router.add('GET', '/evaluation/runs', listEvaluationRuns(app));
  router.add('GET', '/evaluation/runs/:runId', getEvaluationRun(app));
  router.add('GET', '/evaluation/runs/:runId/regression', getEvaluationRunRegression(app));
  router.add('GET', '/evaluation/corrections', listEvaluationCorrections(app));
  router.add('POST', '/evaluation/corrections', addEvaluationCorrection(app));
  router.add('GET', '/evaluation/feedback-dataset', exportEvaluationFeedbackDataset(app));

  const handle = pipeline(app, router);

  return createServer((req, res) => {
    // Decorate ctx with body/query before the pipeline reads them.
    const url = new URL(req.url ?? '/', 'http://localhost');
    void (async () => {
      try {
        (req as unknown as { __body?: unknown }).__body = await readJsonBody(req);
        (req as unknown as { __query?: URLSearchParams }).__query = readQuery(req);
      } catch {
        // body read errors surface in the pipeline as 400/500
      }
      await handle(req, res);
    })();
  });
}

export async function startApi(): Promise<{ server: Server; app: AppContext; port: number }> {
  const app = await compose();
  const server = await createApiServer(app);
  await new Promise<void>((resolve) => server.listen(app.env.APP_PORT, () => resolve()));
  app.log.info('api listening', { port: app.env.APP_PORT });

  const shutdown = async (): Promise<void> => {
    app.log.info('shutting down');
    server.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  return { server, app, port: app.env.APP_PORT };
}

// Entrypoint guard: run only when executed directly.
const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? '#');
if (isMain) {
  await startApi();
}
