/**
 * Shop(+)Plus — Walmart Playwright Agent
 * Handles all browser automation: price fetching, add-to-cart, order placement.
 *
 * NOTE: Playwright runs in headless mode on Railway.
 * Chromium is installed automatically by the playwright package.
 */

const { chromium } = require('playwright');

const WALMART_BASE = 'https://www.walmart.com';

// ─── Browser factory — reuse a single browser across requests ─────────────────

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  return _browser;
}

async function newPage() {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  return context.newPage();
}

// ─── Login to Walmart ─────────────────────────────────────────────────────────

async function loginWalmart(page, credentials) {
  console.log('[walmart] navigating to login...');
  await page.goto(`${WALMART_BASE}/account/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Fill email
  await page.fill('input[name="email"]', credentials.email);
  await page.waitForTimeout(500);

  // Click continue / next if two-step login
  const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next")').first();
  if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await continueBtn.click();
    await page.waitForTimeout(1000);
  }

  // Fill password
  await page.fill('input[name="password"], input[type="password"]', credentials.password);
  await page.waitForTimeout(500);

  // Submit
  const signInBtn = page.locator('button:has-text("Sign in"), button[type="submit"]').first();
  await signInBtn.click();
  await page.waitForTimeout(3000);

  // Verify login succeeded
  const url = page.url();
  const isLoggedIn = !url.includes('/account/login');
  if (!isLoggedIn) {
    throw new Error('Walmart login failed — check credentials or 2FA settings');
  }

  console.log('[walmart] logged in successfully');
  return true;
}

// ─── Fetch prices ─────────────────────────────────────────────────────────────
// Returns { walmart: price } — no login required for price fetching

async function fetchWalmartPrices({ upc, name }) {
  const page = await newPage();
  const prices = {};

  try {
    let searchQuery = name || upc;
    const searchUrl = `${WALMART_BASE}/search?q=${encodeURIComponent(searchQuery)}`;

    console.log(`[walmart] fetching price for: ${searchQuery}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Try to find the first product result and its price
    // Walmart uses data-testid attributes for structured elements
    const priceSelectors = [
      '[data-testid="list-view"] [itemprop="price"]',
      '[data-testid="product-price"]',
      '.price-main .price-group',
      '[data-automation-id="product-price"]',
      'span[itemprop="price"]',
    ];

    let priceText = null;

    for (const selector of priceSelectors) {
      const el = page.locator(selector).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        priceText = await el.textContent();
        break;
      }
    }

    if (priceText) {
      const match = priceText.match(/\$?([\d,]+\.?\d{0,2})/);
      if (match) {
        prices.walmart = parseFloat(match[1].replace(',', ''));
        console.log(`[walmart] price found: $${prices.walmart}`);
      }
    }

    // If UPC matched, also try the direct product page for more accurate price
    if (upc && !priceText) {
      const directUrl = `${WALMART_BASE}/search?q=${upc}`;
      await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);

      for (const selector of priceSelectors) {
        const el = page.locator(selector).first();
        const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          priceText = await el.textContent();
          const match = priceText?.match(/\$?([\d,]+\.?\d{0,2})/);
          if (match) {
            prices.walmart = parseFloat(match[1].replace(',', ''));
            break;
          }
        }
      }
    }

  } catch (e) {
    console.error('[walmart] price fetch error:', e.message);
  } finally {
    await page.close();
  }

  return prices;
}

// ─── Add to cart ──────────────────────────────────────────────────────────────

async function addToWalmartCart({ upc, name, quantity = 1, credentials }) {
  const page = await newPage();

  try {
    // Login first
    await loginWalmart(page, credentials);

    // Search for the product
    const searchQuery = name || upc;
    await page.goto(`${WALMART_BASE}/search?q=${encodeURIComponent(searchQuery)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForTimeout(2000);

    // Click first product result
    const firstProduct = page.locator(
      '[data-testid="list-view"] a[link-identifier], [data-item-id] a, .search-result-gridview-item a'
    ).first();

    const productUrl = await firstProduct.getAttribute('href').catch(() => null);
    if (!productUrl) throw new Error('No product found in search results');

    const fullUrl = productUrl.startsWith('http') ? productUrl : `${WALMART_BASE}${productUrl}`;
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Get product details from page
    const productName = await page.locator('h1[itemprop="name"], h1.prod-ProductTitle').first()
      .textContent().catch(() => name || 'Unknown product');

    const priceEl = page.locator('[itemprop="price"], .price-characteristic').first();
    const priceText = await priceEl.textContent().catch(() => '0');
    const priceMatch = priceText.match(/[\d,]+\.?\d{0,2}/);
    const price = priceMatch ? parseFloat(priceMatch[0].replace(',', '')) : 0;

    // Set quantity if > 1
    if (quantity > 1) {
      const qtyInput = page.locator('input[data-testid="quantity-input"], input[name="quantity"]').first();
      const qtyVisible = await qtyInput.isVisible({ timeout: 3000 }).catch(() => false);
      if (qtyVisible) {
        await qtyInput.fill(String(quantity));
        await page.waitForTimeout(500);
      }
    }

    // Click Add to cart
    const addBtn = page.locator(
      'button:has-text("Add to cart"), button[data-testid="add-to-cart-btn"], [data-automation-id="atc-button"]'
    ).first();

    await addBtn.waitFor({ state: 'visible', timeout: 8000 });
    await addBtn.click();
    await page.waitForTimeout(2500);

    // Confirm cart addition — look for cart count or modal
    const cartConfirmed = await page.locator(
      '[data-testid="cart-count"], .header-cart-count, [aria-label*="cart"]'
    ).first().isVisible({ timeout: 5000 }).catch(() => false);

    console.log(`[walmart] added to cart: ${productName} x${quantity} @ $${price}`);

    return {
      added: true,
      product_name: productName.trim(),
      price,
      quantity,
      cart_confirmed: cartConfirmed,
      product_url: fullUrl,
    };

  } finally {
    await page.close();
  }
}

// ─── Place order ──────────────────────────────────────────────────────────────

async function placeWalmartOrder({ fulfillment = 'pickup', credentials }) {
  const page = await newPage();

  try {
    await loginWalmart(page, credentials);

    // Navigate to cart
    await page.goto(`${WALMART_BASE}/cart`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Collect cart items for the order record
    const cartItems = [];
    const itemEls = await page.locator('[data-testid="cart-line-item"], .cart-item').all();

    for (const el of itemEls) {
      const itemName = await el.locator('a, h3, .cart-item-title').first()
        .textContent().catch(() => 'Unknown');
      const itemPrice = await el.locator('[data-testid="cart-line-item-price"], .price').first()
        .textContent().catch(() => '0');
      const priceMatch = itemPrice.match(/[\d,]+\.?\d{0,2}/);

      cartItems.push({
        name: itemName.trim(),
        price: priceMatch ? parseFloat(priceMatch[0].replace(',', '')) : 0,
        quantity: 1,
      });
    }

    // Click Continue to checkout
    const checkoutBtn = page.locator(
      'button:has-text("Continue to checkout"), button:has-text("Checkout"), [data-testid="checkout-btn"]'
    ).first();
    await checkoutBtn.waitFor({ state: 'visible', timeout: 8000 });
    await checkoutBtn.click();
    await page.waitForTimeout(3000);

    // Select fulfillment method
    if (fulfillment === 'pickup') {
      const pickupOption = page.locator(
        'button:has-text("Pickup"), [data-testid="pickup-option"], label:has-text("Pickup")'
      ).first();
      const pickupVisible = await pickupOption.isVisible({ timeout: 5000 }).catch(() => false);
      if (pickupVisible) {
        await pickupOption.click();
        await page.waitForTimeout(1500);
      }
    } else {
      const deliveryOption = page.locator(
        'button:has-text("Delivery"), [data-testid="delivery-option"], label:has-text("Delivery")'
      ).first();
      const deliveryVisible = await deliveryOption.isVisible({ timeout: 5000 }).catch(() => false);
      if (deliveryVisible) {
        await deliveryOption.click();
        await page.waitForTimeout(1500);
      }
    }

    // Extract pickup time / delivery window before placing
    let pickupTime = null;
    let pickupLocation = null;
    let deliveryWindow = null;

    if (fulfillment === 'pickup') {
      pickupTime = await page.locator(
        '[data-testid="pickup-time"], .pickup-time, [class*="pickup"]'
      ).first().textContent().catch(() => null);
      pickupLocation = await page.locator(
        '[data-testid="store-name"], .store-name, [class*="store-address"]'
      ).first().textContent().catch(() => null);
    } else {
      deliveryWindow = await page.locator(
        '[data-testid="delivery-window"], .delivery-time'
      ).first().textContent().catch(() => null);
    }

    // Extract total
    const totalText = await page.locator(
      '[data-testid="total-price"], .order-total, [class*="total"]'
    ).first().textContent().catch(() => '0');
    const totalMatch = totalText.match(/[\d,]+\.?\d{0,2}/);
    const total = totalMatch ? parseFloat(totalMatch[0].replace(',', '')) : 0;

    // Place the order
    const placeBtn = page.locator(
      'button:has-text("Place order"), button:has-text("Submit order"), [data-testid="place-order-btn"]'
    ).first();
    await placeBtn.waitFor({ state: 'visible', timeout: 10000 });
    await placeBtn.click();
    await page.waitForTimeout(5000);

    // Capture order confirmation number
    const confirmationText = await page.locator(
      '[data-testid="order-number"], [class*="order-confirmation"], [class*="confirmation-number"]'
    ).first().textContent().catch(() => null);

    const orderIdMatch = confirmationText?.match(/\d{6,}/);
    const orderId = orderIdMatch ? `WM-${orderIdMatch[0]}` : `WM-${Date.now()}`;

    console.log(`[walmart] order placed: ${orderId} total=$${total}`);

    return {
      order_id: orderId,
      items: cartItems,
      total,
      fulfillment,
      pickup_time: pickupTime?.trim() || null,
      pickup_location: pickupLocation?.trim() || null,
      delivery_window: deliveryWindow?.trim() || null,
      placed_at: new Date().toISOString(),
    };

  } finally {
    await page.close();
  }
}

module.exports = { fetchWalmartPrices, addToWalmartCart, placeWalmartOrder };
