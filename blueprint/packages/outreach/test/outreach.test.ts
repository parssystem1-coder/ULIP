import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CAMPAIGN_TRANSITION_TABLE,
  canTransitionCampaign,
  OutreachCampaignService,
  ConfirmationMismatchError,
  InvalidCampaignStateError,
  TemplateRenderError,
  extractPlaceholders,
  renderTemplate,
  FakeSocialActionPort,
  InMemoryCampaignStore,
  InMemoryRecipientStore,
  InMemoryTemplateStore,
  OutreachFixedClock,
  OutreachSequentialIds,
} from '../src/index.ts';

interface Harness {
  service: OutreachCampaignService;
  port: FakeSocialActionPort;
  recipients: InMemoryRecipientStore;
}

function buildHarness(portOptions: { supported?: boolean } = {}): Harness {
  const port = new FakeSocialActionPort(portOptions);
  const service = new OutreachCampaignService({
    templates: new InMemoryTemplateStore(),
    campaigns: new InMemoryCampaignStore(),
    recipients: new InMemoryRecipientStore(),
    socialActions: port,
    clock: new OutreachFixedClock(),
    ids: new OutreachSequentialIds(),
  });
  return { service, port, recipients: service['recipients'] as InMemoryRecipientStore };
}

const LEADS = [
  {
    leadId: 'lead-1',
    status: 'QUALIFIED',
    sourceType: 'instagram',
    externalId: 'ig-1',
    profileUrl: 'https://instagram.com/lead1',
    variables: { business_name: 'چاپخانه تهران', city: 'تهران' },
  },
  {
    leadId: 'lead-2',
    status: 'QUALIFIED',
    sourceType: 'instagram',
    externalId: 'ig-2',
    variables: { business_name: 'سالن شیراز', city: 'شیراز' },
  },
] as const;

async function setupCampaign(
  h: Harness,
  campaignId: string,
  leads: readonly unknown[] = LEADS,
): Promise<void> {
  await h.service.createTemplate({
    tenantId: 'tenant-1',
    name: 'intro-fa',
    body: 'سلام {{business_name}}، محصولات شما در {{city}} عالی است.',
    createdBy: 'user-1',
  });
  const campaign = await h.service.createCampaign({
    tenantId: 'tenant-1',
    name: 'Tehran Printers',
    templateId: 'oid-0001',
    filters: { businessTypes: ['wholesaler'], specialties: ['printing'], city: 'تهران' },
    createdBy: 'user-1',
  });
  // deterministic id: first campaign gets oid-0002
  assert.equal(campaign.id, campaignId);
  await h.service.selectRecipients('tenant-1', campaign.id, 'user-1', leads as never);
}

test('template placeholders: extract + strict render + missing variable error', async () => {
  assert.deepEqual(extractPlaceholders('سلام {{business_name}} در {{city}}'), [
    'business_name',
    'city',
  ]);
  assert.equal(
    renderTemplate('سلام {{business_name}}', { business_name: 'چاپخانه' }),
    'سلام چاپخانه',
  );
  assert.throws(
    () => renderTemplate('سلام {{business_name}}', {}),
    TemplateRenderError,
  );
});

test('eligibility rules: suppression wins, then cool-down, identity, capability, readiness', async () => {
  const { evaluateEligibility } = await import('../src/eligibility.ts');
  const base = {
    lead: { leadId: 'l1', status: 'QUALIFIED' as const, sourceType: 'instagram', externalId: 'ig-1' },
    actionSupported: true,
    coolDownWindowHours: 24,
    nowIso: '2026-10-05T00:00:00.000Z',
  };
  assert.equal(evaluateEligibility(base).eligible, true);

  const suppressed = evaluateEligibility({ ...base, lead: { ...base.lead, suppressed: { reason: 'UNSUBSCRIBED' } } });
  assert.equal(suppressed.eligible, false);
  assert.equal(suppressed.reason, 'SUPPRESSED');

  const recent = evaluateEligibility({
    ...base,
    lead: { ...base.lead, lastContactAt: '2026-10-04T12:00:00.000Z' },
  });
  assert.equal(recent.eligible, false);
  assert.equal(recent.reason, 'RECENT_CONTACT');

  const noIdentity = evaluateEligibility({
    ...base,
    lead: { leadId: 'l1', status: 'QUALIFIED', sourceType: 'instagram' },
  });
  assert.equal(noIdentity.eligible, false);
  assert.equal(noIdentity.reason, 'MISSING_IDENTITY');

  const unsupported = evaluateEligibility({ ...base, actionSupported: false });
  assert.equal(unsupported.eligible, false);
  assert.equal(unsupported.reason, 'ACTION_NOT_SUPPORTED');

  const notReady = evaluateEligibility({ ...base, lead: { ...base.lead, status: 'DISCOVERED' } });
  assert.equal(notReady.eligible, false);
  assert.equal(notReady.reason, 'LEAD_NOT_READY');
});

test('campaign transition table: EXECUTING reachable only from APPROVED', () => {
  const intoExecuting = CAMPAIGN_TRANSITION_TABLE.filter((t) => t.to === 'EXECUTING');
  assert.deepEqual(
    intoExecuting.map((t) => [t.from, t.event]).sort(),
    [
      ['APPROVED', 'START'],
      ['COMPLETED', 'RESUME'],
      ['PAUSED', 'RESUME'],
    ].sort(),
  );
  const intoApproved = CAMPAIGN_TRANSITION_TABLE.filter((t) => t.to === 'APPROVED');
  assert.deepEqual(intoApproved.map((t) => [t.from, t.event]), [['PENDING_APPROVAL', 'APPROVE']]);
  assert.equal(canTransitionCampaign('DRAFT', 'START', 'EXECUTING'), false);
});

test('bulk flow: select → preview → confirm → execute sends ONE message per lead', async () => {
  const h = buildHarness({ supported: true });
  await setupCampaign(h, 'oid-0002');

  const summary = await h.service.selectRecipients('tenant-1', 'oid-0002', 'user-1', LEADS as never);
  assert.equal(summary.total, 2);
  assert.equal(summary.eligible, 2);
  assert.equal(summary.previews.length, 2);
  // per-lead distinct rendered messages (not one shared group text)
  assert.ok((summary.previews[0]?.message ?? '').includes('چاپخانه تهران'));
  assert.ok((summary.previews[1]?.message ?? '').includes('سالن شیراز'));

  // confirmation gate: executing before approval is rejected
  await assert.rejects(
    h.service.executeBulk('tenant-1', 'oid-0002', 'user-1'),
    InvalidCampaignStateError,
  );

  await h.service.submitForApproval('tenant-1', 'oid-0002', 'user-1');

  // confirmation with wrong numbers is a mismatch
  await assert.rejects(
    h.service.confirmExecution({
      tenantId: 'tenant-1',
      campaignId: 'oid-0002',
      actorId: 'admin-1',
      expected: { recipients: 5, eligible: 5 },
    }),
    ConfirmationMismatchError,
  );

  await h.service.confirmExecution({
    tenantId: 'tenant-1',
    campaignId: 'oid-0002',
    actorId: 'admin-1',
    expected: { recipients: 2, eligible: 2 },
  });

  const report = await h.service.executeBulk('tenant-1', 'oid-0002', 'user-1');
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.totals.sent, 2);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.progress, 100);

  // THE invariant: one separate message per lead — 2 leads, 2 distinct sends
  assert.equal(h.port.sends.length, 2);
  assert.notEqual(h.port.sends[0]?.message, h.port.sends[1]?.message);
  assert.equal(h.port.sends[0]?.leadId, 'lead-1');
  assert.equal(h.port.sends[1]?.leadId, 'lead-2');
});

test('recipient list: one row per (campaign, lead), each with its own rendered message', async () => {
  const h = buildHarness({ supported: true });
  await setupCampaign(h, 'oid-0002');
  const rows = await h.recipients.listByCampaign('tenant-1', 'oid-0002');
  assert.equal(rows.length, 2);
  const messages = new Set(rows.map((r) => r.renderedMessage));
  assert.equal(messages.size, 2);
});

test('eligibility at selection: suppressed, unsupported and unqualified leads never enter the send list', async () => {
  const h = buildHarness({ supported: true });
  await h.service.createTemplate({
    tenantId: 'tenant-1',
    name: 't',
    body: 'سلام {{business_name}}',
    createdBy: 'user-1',
  });
  await h.service.createCampaign({
    tenantId: 'tenant-1',
    name: 'mixed',
    templateId: 'oid-0001',
    filters: {},
    createdBy: 'user-1',
  });
  const summary = await h.service.selectRecipients('tenant-1', 'oid-0002', 'user-1', [
    LEADS[0],
    { leadId: 'lead-supp', status: 'QUALIFIED', sourceType: 'instagram', externalId: 'ig-s', suppressed: { reason: 'MANUAL' }, variables: { business_name: 'x' } },
    { leadId: 'lead-new', status: 'DISCOVERED', sourceType: 'instagram', externalId: 'ig-n', variables: { business_name: 'x' } },
  ] as never);
  assert.equal(summary.total, 3);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.ineligible, 2);
  assert.equal(summary.byReason.SUPPRESSED, 1);
  assert.equal(summary.byReason.LEAD_NOT_READY, 1);

  // unsupported source cannot enter the send list at all
  const h2 = buildHarness({ supported: false });
  await h2.service.createTemplate({ tenantId: 'tenant-1', name: 't2', body: 'salam', createdBy: 'user-1' });
  await h2.service.createCampaign({ tenantId: 'tenant-1', name: 'c2', templateId: 'oid-0001', filters: {}, createdBy: 'user-1' });
  const s2 = await h2.service.selectRecipients('tenant-1', 'oid-0002', 'user-1', [LEADS[0]] as never);
  assert.equal(s2.eligible, 0);
  assert.equal(s2.byReason.ACTION_NOT_SUPPORTED, 1);
});

test('retry safety: re-running execution never re-sends to SENT recipients', async () => {
  const h = buildHarness({ supported: true });
  await setupCampaign(h, 'oid-0002');
  await h.service.submitForApproval('tenant-1', 'oid-0002', 'user-1');
  await h.service.confirmExecution({
    tenantId: 'tenant-1',
    campaignId: 'oid-0002',
    actorId: 'admin-1',
    expected: { recipients: 2, eligible: 2 },
  });
  await h.service.executeBulk('tenant-1', 'oid-0002', 'user-1');
  assert.equal(h.port.sends.length, 2);

  // A re-run (e.g. crashed job retried) sends nothing new.
  const again = await h.service.executeBulk('tenant-1', 'oid-0002', 'user-1');
  assert.equal(h.port.sends.length, 2);
  assert.equal(again.totals.sent, 2);
});

test('provider failure marks recipient FAILED and the retry sends exactly one more message', async () => {
  const h = buildHarness({ supported: true });
  await setupCampaign(h, 'oid-0002');
  h.port.setScript([{ status: 'FAILED', errorCode: 'RATE_LIMITED' }]);
  await h.service.submitForApproval('tenant-1', 'oid-0002', 'user-1');
  await h.service.confirmExecution({
    tenantId: 'tenant-1',
    campaignId: 'oid-0002',
    actorId: 'admin-1',
    expected: { recipients: 2, eligible: 2 },
  });
  const first = await h.service.executeBulk('tenant-1', 'oid-0002', 'user-1');
  assert.equal(first.totals.failed, 2); // script repeats last outcome
  assert.equal(h.port.sends.length, 2);

  h.port.setScript([{ status: 'SUCCEEDED' }]);
  const retried = await h.service.executeBulk('tenant-1', 'oid-0002', 'user-1');
  assert.equal(retried.totals.sent, 2);
  assert.equal(h.port.sends.length, 4); // 2 first-run + 2 retry, never more
  assert.equal(retried.progress, 100);
});

test('cancellation stops bulk execution cooperatively and cancels pending recipients', async () => {
  const h = buildHarness({ supported: true });
  await setupCampaign(h, 'oid-0002');
  await h.service.submitForApproval('tenant-1', 'oid-0002', 'user-1');
  await h.service.confirmExecution({
    tenantId: 'tenant-1',
    campaignId: 'oid-0002',
    actorId: 'admin-1',
    expected: { recipients: 2, eligible: 2 },
  });

  const report = await h.service.executeBulk('tenant-1', 'oid-0002', 'user-1', {
    shouldContinue: () => false, // cancelled before the first recipient
  });
  assert.equal(h.port.sends.length, 0);
  assert.equal(report.status, 'EXECUTING'); // stopped mid-way, not COMPLETED

  const cancelled = await h.service.cancel('tenant-1', 'oid-0002', 'admin-1', 'operator request');
  assert.equal(cancelled.status, 'CANCELLED');
  const rows = await h.recipients.listByCampaign('tenant-1', 'oid-0002');
  assert.ok(rows.every((r) => r.status === 'CANCELLED'));
});

test('tenant isolation: campaigns and recipients never cross tenants', async () => {
  const h = buildHarness({ supported: true });
  await setupCampaign(h, 'oid-0002');
  const { CampaignNotFoundError } = await import('../src/index.ts');
  await assert.rejects(
    h.service.getCampaign('tenant-2', 'oid-0002'),
    CampaignNotFoundError,
  );
  const rows = await h.recipients.listByCampaign('tenant-2', 'oid-0002');
  assert.equal(rows.length, 0);
});

test('template error at selection: unrenderable variables mark recipient TEMPLATE_ERROR, not a bad send', async () => {
  const h = buildHarness({ supported: true });
  await h.service.createTemplate({
    tenantId: 'tenant-1',
    name: 'needs-var',
    body: 'سلام {{business_name}} {{missing_var}}',
    createdBy: 'user-1',
  });
  await h.service.createCampaign({
    tenantId: 'tenant-1',
    name: 'c',
    templateId: 'oid-0001',
    filters: {},
    createdBy: 'user-1',
  });
  const summary = await h.service.selectRecipients('tenant-1', 'oid-0002', 'user-1', [
    { leadId: 'lead-1', status: 'QUALIFIED', sourceType: 'instagram', externalId: 'ig-1', variables: { business_name: 'x' } },
  ] as never);
  assert.equal(summary.eligible, 0);
  assert.equal(summary.byReason.TEMPLATE_ERROR, 1);
});
