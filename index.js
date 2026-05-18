/**
 * Shop(+)Plus — Railway Playwright Agent
 * Express server that receives calls from the Cloudflare Worker
 * and executes browser automation against Walmart.
 *
 * Environment variables (set in Railway dashboard → Variables):
 *   PORT              → set automatically by Railway
 *   AGENT_SECRET      → must match JARVIS_SECRET in your CF Worker secrets
 */

const express = require('express');
const { fetchWalmartPrices, addToWalmartCart, placeWalmartOrder } = require('./agent/walmart');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const AGENT_SECRET = process.env.AGENT_SECRET || '';

// ─── Auth middleware ──────────────────────────────────────────────────────────

function auth(req, res, next) {
  const secret = req.headers['x-agent-secret'];
  if (AGENT_SECRET && secret !== AGENT_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'shopplus-agent', ts: new Date().toISOString() });
});

// ─── Fetch live prices ────────────────────────────────────────────────────────
// Called by CF Worker /prices/compare and cron surge detection
// Body: { upc?, name? }
// Returns: { walmart: 7.48, target: 8.29, ... }

app.post('/fetch-prices', auth, async (req, res) => {
  const { upc, name } = req.body;
  if (!upc && !name) {
    return res.status(400).json({ ok: false, error: 'upc or name required' });
  }

  console.log(`[fetch-prices] upc=${upc} name=${name}`);

  try {
    const prices = await fetchWalmartPrices({ upc, name });
    res.json({ ok: true, ...prices });
  } catch (e) {
    console.error('[fetch-prices] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Add to cart ──────────────────────────────────────────────────────────────
// Body: { upc?, name?, retailer, quantity, credentials: { email, password } }

app.post('/add-to-cart', auth, async (req, res) => {
  const { upc, name, retailer = 'walmart', quantity = 1, credentials } = req.body;

  if (!credentials?.email || !credentials?.password) {
    return res.status(400).json({ ok: false, error: 'credentials required' });
  }
  if (!upc && !name) {
    return res.status(400).json({ ok: false, error: 'upc or name required' });
  }

  console.log(`[add-to-cart] retailer=${retailer} upc=${upc} qty=${quantity}`);

  try {
    const result = await addToWalmartCart({ upc, name, quantity, credentials });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[add-to-cart] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Place order ──────────────────────────────────────────────────────────────
// Body: { retailer, fulfillment: 'pickup'|'delivery', credentials: { email, password } }

app.post('/place-order', auth, async (req, res) => {
  const { retailer = 'walmart', fulfillment = 'pickup', credentials } = req.body;

  if (!credentials?.email || !credentials?.password) {
    return res.status(400).json({ ok: false, error: 'credentials required' });
  }

  console.log(`[place-order] retailer=${retailer} fulfillment=${fulfillment}`);

  try {
    const result = await placeWalmartOrder({ fulfillment, credentials });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[place-order] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Shop(+)Plus agent running on port ${PORT}`);
});
