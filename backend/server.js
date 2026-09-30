require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { loginBodySchema, validate } = require('./validation');
const { createAuditLog } = require('./audit');
const { createStaffStore } = require('./staff');
const { createSessionStore } = require('./sessions');
const { permissionsFor } = require('./permissions');
const { createRateLimiter } = require('./rate-limit');
const { createRentalStore } = require('./rentals');
const { createRequestStore } = require('./requests');
const { loadOffice } = require('./office');
const { createPublicAssistant, chatRequestSchema } = require('./chat');

const app = express();
const PORT = process.env.PORT || 3000;
// Lease dates are local calendar dates, so "today" is taken in the business's
// time zone rather than the server's (often UTC).
const TIME_ZONE = process.env.TIME_ZONE || 'America/Toronto';

function todayInTimeZone() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const dataDir = path.join(__dirname, '..', 'data');
const auditLog = createAuditLog(path.join(dataDir, 'audit-log.jsonl'));
const staffStore = createStaffStore(path.join(dataDir, 'staff.json'));
const rentalStore = createRentalStore(dataDir, { today: todayInTimeZone });
// Fail at startup, not on the first request, if the data files are missing or invalid.
rentalStore.load();
loadOffice(dataDir);
const requestStore = createRequestStore(dataDir, auditLog, { rentalStore });

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    // Every script, style, and request on these pages is same-origin, with no
    // inline scripts or style attributes, so nothing else needs allowing.
    'Content-Security-Policy':
      "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

// Keyed by req.ip, which is the socket address until 'trust proxy' is set for
// a deployment behind a proxy.
function rateLimit(limiter) {
  return (req, res, next) => {
    const { allowed, retryAfterMs } = limiter.take(req.ip);
    if (!allowed) {
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ error: 'too_many_requests' });
    }
    next();
  };
}
const loginLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
const chatLimiter = createRateLimiter({ limit: 20, windowMs: 60 * 1000 });
// Separate from chatLimiter so one visitor can't flood staff with requests.
const submitLimiter = createRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });

const assistant = createPublicAssistant({
  anthropic: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  rentalStore,
  requestStore,
  loadOffice: () => loadOffice(dataDir),
  today: todayInTimeZone,
  submitLimiter,
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use(express.json());

const CHAT_ERROR_REPLY = "Sorry, I'm having trouble responding right now. Please try again in a moment.";

app.post('/api/chat', rateLimit(chatLimiter), async (req, res) => {
  const { data, error } = validate(chatRequestSchema, req.body);
  if (error) {
    return res.status(400).json(error);
  }
  try {
    const reply = await assistant.reply(data, req.ip);
    if (!reply) {
      return res.status(502).json({ reply: CHAT_ERROR_REPLY });
    }
    res.json({
      reply,
      conversationHistory: [
        ...data.conversationHistory,
        { role: 'user', content: data.message },
        { role: 'assistant', content: reply },
      ],
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ reply: CHAT_ERROR_REPLY });
  }
});

const SESSION_COOKIE = 'staff_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessionStore = createSessionStore({ ttlMs: SESSION_TTL_MS });

function readSessionToken(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value;
  }
  return null;
}

app.post('/api/staff/login', rateLimit(loginLimiter), (req, res) => {
  const { data, error } = validate(loginBodySchema, req.body);
  if (error) {
    return res.status(400).json(error);
  }

  const member = staffStore.verify(data.username, data.password);
  if (!member) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  auditLog.append({
    actorType: 'STAFF',
    actorId: member.username,
    action: 'LOGIN',
    entityType: 'STAFF',
    entityId: member.username,
    before: null,
    after: null,
    reason: null,
  });
  res.cookie(SESSION_COOKIE, sessionStore.create(member.username, member.role), {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ username: member.username, role: member.role });
});

app.post('/api/staff/logout', (req, res) => {
  sessionStore.destroy(readSessionToken(req));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true });
});

// Every /api/staff route registered after this point requires a signed-in staff member.
app.use('/api/staff', (req, res, next) => {
  const session = sessionStore.get(readSessionToken(req));
  if (!session) {
    return res.status(401).json({ error: 'not_signed_in' });
  }
  req.staff = session;
  next();
});

app.get('/api/staff/me', (req, res) => {
  const { username, role } = req.staff;
  res.json({ username, role, permissions: permissionsFor(role) });
});

app.get('/api/staff/properties', (req, res) => {
  const result = rentalStore.overview(req.staff);
  if (result.error) {
    return res.status(403).json(result);
  }
  res.json(result);
});

// Replaces Express's default error page, which exposes a stack trace (e.g. on
// malformed JSON bodies).
app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) {
    console.error(err);
  }
  res.status(status).json({ error: status === 500 ? 'internal_error' : err.type || 'bad_request' });
});

app.listen(PORT, () => {
  console.log(`RentLedger server running on http://localhost:${PORT}`);
});
