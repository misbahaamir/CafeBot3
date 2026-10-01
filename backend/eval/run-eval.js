// Live-model eval for both assistants: npm run eval [-- --only chat|ledger] [--case <id>] [--repeat <n>]
//
// Every run calls the Claude API and costs money. It uses only the fictional
// sample data (copied to a temporary folder), so no real tenant data is sent
// and no real request, ledger, or audit file is touched.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const os = require('os');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { createRentalStore } = require('../rentals');
const { createRequestStore } = require('../requests');
const { createAuditLog } = require('../audit');
const { loadOffice } = require('../office');
const { createPublicAssistant } = require('../chat');
const { createLedgerAssistant } = require('../ledger-assistant');
const { createRateLimiter } = require('../rate-limit');
const { EVAL_TODAY, PUBLIC_CHAT_CASES, LEDGER_DRAFT_CASES } = require('./cases');

// Claude Sonnet 5.5 list prices in US dollars per million tokens, from
// Anthropic's model documentation as of 2026-10-01. Used only for the cost
// estimate printed at the end; check current pricing before relying on it.
const INPUT_USD_PER_MTOK = 2;
const OUTPUT_USD_PER_MTOK = 10;

function parseArgs(argv) {
  const args = { only: null, caseId: null, repeat: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') args.only = argv[++i];
    else if (argv[i] === '--case') args.caseId = argv[++i];
    else if (argv[i] === '--repeat') args.repeat = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (args.only && !['chat', 'ledger'].includes(args.only)) throw new Error('--only must be chat or ledger');
  if (!Number.isInteger(args.repeat) || args.repeat < 1 || args.repeat > 10) throw new Error('--repeat must be 1-10');
  return args;
}

function sampleDataDir() {
  const sampleDir = path.join(__dirname, '..', '..', 'data', 'sample');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rentledger-eval-'));
  for (const file of fs.readdirSync(sampleDir)) {
    fs.copyFileSync(path.join(sampleDir, file), path.join(dir, file));
  }
  return dir;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Everything the public assistant must never say unless the visitor said it
// first: it is never given tenant or lease data, so any of these in a reply
// would be invented or leaked.
function privateDetails(dataDir) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf-8'));
  const details = [];
  for (const tenant of read('tenants')) {
    details.push(tenant.fullName, tenant.email, tenant.phone);
  }
  const listedRents = new Set(read('units').filter((u) => u.listing).map((u) => u.defaultRentCents));
  for (const lease of read('leases')) {
    if (listedRents.has(lease.rentCents)) continue;
    const dollars = String(Math.floor(lease.rentCents / 100));
    const withComma = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    details.push(new RegExp(`\\b(${escapeRegExp(dollars)}|${escapeRegExp(withComma)})(\\.\\d\\d)?\\b`));
  }
  return details.map((d) => (d instanceof RegExp ? d : new RegExp(escapeRegExp(d), 'i')));
}

function matches(expected, actual) {
  if (Array.isArray(expected)) return expected.some((e) => matches(e, actual));
  if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual);
  return expected === actual;
}

function describe(value) {
  return value instanceof RegExp ? String(value) : JSON.stringify(value);
}

function checkFields(label, expected, actual, failures) {
  for (const [field, want] of Object.entries(expected)) {
    if (!actual || !matches(want, actual[field])) {
      failures.push(`${label}.${field}: expected ${describe(want)}, got ${JSON.stringify(actual ? actual[field] : undefined)}`);
    }
  }
}

function createCountingClient(client, usage) {
  return {
    messages: {
      create: async (params) => {
        const response = await client.messages.create(params);
        usage.calls += 1;
        usage.inputTokens += response.usage.input_tokens;
        usage.outputTokens += response.usage.output_tokens;
        return response;
      },
    },
  };
}

async function runChatCase(testCase, { assistant, counters, created, details }) {
  const failures = [];
  const transcript = [];
  let history = [];
  for (const [index, turn] of testCase.turns.entries()) {
    counters.listings = 0;
    counters.maintenance = 0;
    counters.viewing = 0;
    const reply = await assistant.reply({ message: turn.say, conversationHistory: history }, `eval-${testCase.id}`);
    transcript.push({ user: turn.say, assistant: reply });
    history = [...history, { role: 'user', content: turn.say }, { role: 'assistant', content: reply }].slice(-10);

    const label = `turn ${index + 1}`;
    const { expect } = turn;
    if (expect.listings !== undefined && (counters.listings > 0) !== expect.listings) {
      failures.push(`${label}: listings ${expect.listings ? 'not looked up' : 'looked up unexpectedly'}`);
    }
    for (const kind of ['maintenance', 'viewing']) {
      if (expect[kind] !== undefined && counters[kind] !== expect[kind]) {
        failures.push(`${label}: expected ${expect[kind]} ${kind} request(s), got ${counters[kind]}`);
      }
    }
    if (expect.maintenanceFields) checkFields(`${label} maintenance`, expect.maintenanceFields, created.maintenance.at(-1), failures);
    if (expect.viewingFields) checkFields(`${label} viewing`, expect.viewingFields, created.viewing.at(-1), failures);
    for (const pattern of expect.replyMatches || []) {
      if (!pattern.test(reply)) failures.push(`${label}: reply does not match ${pattern}`);
    }
    for (const pattern of expect.replyNotMatches || []) {
      if (pattern.test(reply)) failures.push(`${label}: reply matches forbidden ${pattern}`);
    }
    if (expect.replyIncludesReference) {
      const latest = [...created.maintenance, ...created.viewing].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
      if (!latest || !reply.includes(latest.id)) failures.push(`${label}: reply does not include the reference number`);
    }
    const typed = testCase.turns.slice(0, index + 1).map((t) => t.say).join('\n');
    for (const detail of details) {
      if (detail.test(reply) && !detail.test(typed)) failures.push(`${label}: reply contains private detail ${detail}`);
    }
  }
  return { failures, transcript };
}

async function runLedgerCase(testCase, { ledgerAssistant }) {
  const result = await ledgerAssistant.draft({ message: testCase.message }, { username: 'eval', role: 'MANAGER' });
  const failures = [];
  if (result.error) {
    failures.push(`no draft: ${result.error}`);
  } else {
    checkFields('draft', testCase.expect, result.draft, failures);
  }
  return { failures, transcript: [{ user: testCase.message, draft: result.draft || result }] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Add it to .env (never commit it) or the environment, then run again.');
    process.exit(2);
  }

  const dataDir = sampleDataDir();
  const today = () => EVAL_TODAY;
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const anthropic = createCountingClient(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), usage);
  const rentalStore = createRentalStore(dataDir, { today });
  const requestStore = createRequestStore(dataDir, createAuditLog(path.join(dataDir, 'audit-log.jsonl')), { rentalStore });

  const counters = { listings: 0, maintenance: 0, viewing: 0 };
  const created = { maintenance: [], viewing: [] };
  const assistant = createPublicAssistant({
    anthropic,
    rentalStore: {
      listings: () => {
        counters.listings += 1;
        return rentalStore.listings();
      },
    },
    requestStore: {
      createMaintenance: (fields) => {
        counters.maintenance += 1;
        const request = requestStore.createMaintenance(fields);
        created.maintenance.push(request);
        return request;
      },
      createViewing: (fields) => {
        const request = requestStore.createViewing(fields);
        if (!request.error) {
          counters.viewing += 1;
          created.viewing.push(request);
        }
        return request;
      },
    },
    loadOffice: () => loadOffice(dataDir),
    today,
    submitLimiter: createRateLimiter({ limit: 1000, windowMs: 60 * 60 * 1000 }),
  });
  const ledgerAssistant = createLedgerAssistant({ anthropic, rentalStore, today });
  const details = privateDetails(dataDir);

  const suites = [];
  if (args.only !== 'ledger') suites.push(['chat', PUBLIC_CHAT_CASES, runChatCase]);
  if (args.only !== 'chat') suites.push(['ledger', LEDGER_DRAFT_CASES, runLedgerCase]);

  const results = [];
  for (const [suite, cases, run] of suites) {
    for (const testCase of cases.filter((c) => !args.caseId || c.id === args.caseId)) {
      for (let attempt = 1; attempt <= args.repeat; attempt += 1) {
        let outcome;
        try {
          outcome = await run(testCase, { assistant, counters, created, details, ledgerAssistant });
        } catch (err) {
          outcome = { failures: [`error: ${err.message}`], transcript: [] };
        }
        results.push({ suite, id: testCase.id, attempt, note: testCase.note || null, ...outcome });
        const status = outcome.failures.length === 0 ? 'PASS' : 'FAIL';
        console.log(`${status}  ${suite}/${testCase.id}${args.repeat > 1 ? ` #${attempt}` : ''}`);
        for (const failure of outcome.failures) console.log(`      - ${failure}`);
        if (testCase.note) console.log(`      (read: ${testCase.note})`);
      }
    }
  }

  const passed = results.filter((r) => r.failures.length === 0).length;
  const microUsd = usage.inputTokens * INPUT_USD_PER_MTOK + usage.outputTokens * OUTPUT_USD_PER_MTOK;
  console.log(`\n${passed}/${results.length} passed. ${usage.calls} API calls, ${usage.inputTokens} input + ${usage.outputTokens} output tokens`);
  console.log(`Approximate cost: $${(microUsd / 1e6).toFixed(2)} USD (list prices; check current pricing)`);

  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ today: EVAL_TODAY, usage, results }, null, 2));
  console.log(`Transcripts: ${path.relative(process.cwd(), file)}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
