// ══════════════════════════════════════════════════════════════════════
// stylebox-shopify-order-transfer-worker
// v2.3.2 — 30-07-2026
//
// يستقبل WooCommerce webhook (Topic: "Order updated") من stylebox.online،
// وبيعالج بس اللحظة اللي الأوردر بيوصل فيها لحالة "processing" — دي أول
// لحظة الأوردر بيبقى فيها حقيقي وجاهز، تلقائياً وبدون أي تدخل يدوي أو
// تغيير حالة من حد (الـ COD gateway في WooCommerce بيحط الحالة دي أوتوماتيك
// وقت الـ checkout مباشرة).
//
// ⚠️ ليه مش order.created:
// order.created بيتفعّل وقت ما الأوردر يتعمل لأول مرة (حالته وقتها "pending"
// أو حتى قبل كده مع WooCommerce Blocks checkout) — أي قبل ما بوابة الدفع
// (COD) تغيّر الحالة لـ processing في save منفصل. فالفلترة على status هنا
// لازم تكون على order.updated + processing، مش order.created.
//
// v2.2.0 — حماية ضد قتل Cloudflare للتنفيذ بالقوة بعد 30 ثانية داخل
// ctx.waitUntil() (موثّق رسمياً: developers.cloudflare.com/workers/
// platform/limits) — بيحصل من غير ما الكود ياخد فرصة يعمل catch/log،
// فبيسيب الأوردر عالق على in_progress للأبد. الحل: timeout متحكم فيه
// (fetchWithTimeout) على كل نداء خارجي + STALE_IN_PROGRESS_MS reclaim
// بعد 3 دقايق في claimOrder — الحماية دي باقية وسارية على كل أوردر لايف.
//
// v2.3.0 — إلغاء §BACKFILL بالكامل (كانت مؤقتة لترحيل 21 أوردر قديم،
// اتنقلوا بنجاح ومحتاجينش الخاصية دي تاني). محتاج تشيل الـ secrets/vars
// دي من الـ Worker settings: WC_CONSUMER_KEY, WC_CONSUMER_SECRET,
// WC_DOMAIN — مش مستخدمة في أي حاجة تانية في الكود.
//
// v2.3.2 — ⚠️ إصلاح: ملاحظة العميل (customer_note) كانت بتضيع بالكامل
// السبب (مؤكد 100% من raw JSON بتاع WooCommerce REST API، أوردر #16334):
// WooCommerce فعلاً بيبعت الحقل customer_note في الـ webhook payload وفيه
// النص كامل — لكن buildDraftInput() مكانش بيقرا الحقل ده أصلاً ولا بيحطه
// في input.note. مش مشكلة ترميز أو فقدان بيانات من WooCommerce — الحقل
// كان ببساطة مش متربط في المابينج من الأول. الحل: قراءة body.customer_note
// وتعيينه لـ input.note (اسم الحقل في DraftOrderInput هو "note" — لاحظ إن
// DraftOrder بيرجّعه وقت القراءة باسم "note2"، ده اختلاف بين input/output
// موثّق في Shopify GraphQL، مش خطأ). اتعمله decodeHtmlEntities() كمان
// لنفس سبب v2.3.1 (أمان إضافي لو الملاحظة فيها "&" أو حروف خاصة).
//
// v2.3.1 — ⚠️ إصلاح "Address can't contain HTML" على Shopify
// السبب (مؤكد 100% من raw JSON بتاع WooCommerce REST API نفسه، أوردر
// stylebox #16333): WooCommerce بيرجّع/يخزّن حقول العنوان زي address_1
// بترميز HTML حرفي (مثال: "Serenity hotels &amp; resort" بدل "Serenity
// hotels & resort") — ده مش نتيجة أي كود في الـ worker ده، الترميز موجود
// من مصدر WooCommerce نفسه. Shopify بيرفض أي عنوان فيه HTML entity حرفي
// برسالة "Address can't contain HTML". الحل: decodeHtmlEntities() على كل
// حقول النص (address1/2, city, firstName, lastName) قبل ما تتبعت لـ
// Shopify — في buildAddress() وفي findOrCreateCustomer(). أوردرات اتعملت
// قبل الإصلاح ده مش بتتصلح تلقائياً (لازم تعديل يدوي من Shopify Admin —
// الأوردر editable لأنه معمول عن طريق draftOrderComplete).
// ══════════════════════════════════════════════════════════════════════//
// v2.4.0 — 12-09-2026 — إضافة نصف الواجهة (شاشة عرض على GitHub Pages).
// ⚠️ مسار الويبهوك (§WEBHOOK) و§SHOPIFY ما اتلمسوش خالص — التغيير كله
// endpoints قراءة جديدة + شاشة دخول:
//   · Universal D1 Auth (check_employee · register_pin · verify_employee ·
//     log_logout · get_employees) → بيكتب login/logout تحت نفس الـ TOOL_NAME
//   · get_config + diag — حارس نسخة الـ Worker والفحص الذاتي
//   · get_logs / get_logs_count / get_logs_export بقوا على Log Filter Model v2
//     (قوايم employees/types + dateFrom/dateTo + cap/total/truncated)
//   · get_summary + get_attention — أرقام الشاشة والصفوف المحتاجة انتباه
// skills: worker-builder v3.0.0 · constants v2.0.0 · html-builder v7.0.0 — 12-09-2026
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════════════
const TOOL_NAME         = 'wc_order_transfer';  // ⚠️ كان 'wc_sync' قبل كده — راجع ملاحظة الـ migration
const COD_GATEWAY_GID   = 'gid://shopify/PaymentGateway/125688283458';
const STORE_CURRENCY    = 'EGP';   // ⚠️ تأكد إن عملة المتجر على Shopify فعلاً EGP
const WORKER_VERSION    = 'v2.4.0';  // ← بيرجع في ?action=get_config — حارس الواجهة
const STALE_LEDGER_MS   = 3 * 60 * 1000;  // نفس عتبة STALE_IN_PROGRESS_MS — للعرض بس

// الواجهة الوحيدة اللي بتنادي الـ Worker ده. القايمة **مقفولة** لأن appId جاي
// من العميل وجدول logs مشترك بين كل أدوات الستاك.
const AUTH_APPS = new Set([TOOL_NAME]);
function resolveAuthTool(appId) { return AUTH_APPS.has(appId) ? appId : TOOL_NAME; }

const LOG_EXPORT_MAX = 2000;   // سقف التصدير — بيرجع للواجهة كـ cap

// ══════════════════════════════════════════════════════════════════════
// §CORS
// Wildcard: هذا Worker webhook receiver — مفيش HTML frontend يستدعيه
// Admin endpoints (logs) محمية بـ WORKER_SECRET مش CORS
// ══════════════════════════════════════════════════════════════════════
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function getCORSHeaders() { return CORS_HEADERS; }

// ══════════════════════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════════════════════
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─── §HELPERS::decodeHtmlEntities ──────────────────────────────────────
/**
 * ⚠️ v2.3.1 — يفك أي HTML entities جاية من WooCommerce.
 * مؤكد (raw WC REST API JSON, أوردر #16333): WooCommerce بيرجّع &amp;
 * بدل & في address_1 — الترميز ده من WooCommerce نفسه مش من الـ worker.
 * Shopify بيرفض عناوين فيها HTML حرفي برسالة "Address can't contain HTML"
 * فلازم decode لأي حقل نص جاي من WC قبل ما يتبعت في DraftOrderInput.
 */
function decodeHtmlEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// ══════════════════════════════════════════════════════════════════════
// §SHARED — copy verbatim — never modify
// Auth & Logging Functions — EcomModa D1 Pattern v1.3.0
// ══════════════════════════════════════════════════════════════════════
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();
  if (!row) return null;
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username).run().catch(() => {});
  return row.display_name;
}

async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();
  if (!row) return { exists: false, hasPin: false, isActive: false };
  return { exists: true, hasPin: !!row.pin, isActive: !!row.is_active };
}

async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();
  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');
  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?').bind(pin, username).run();
  return true;
}

async function writeLog(db, entry) {
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    entry.extra ? JSON.stringify(entry.extra) : null
  ).run();
}

/**
 * ⚠️ Log Filter Model v2 (v2.4.0) — الدوال التلاتة تحت بقت بتتبني على
 * buildLogFilterSQL بدل SQL مكرر في كل واحدة. النسخة دي هي المعتمدة في
 * `ecommoda-worker-builder` → references/shared-functions.md، والسلوك من غير
 * الباراميترات الجديدة **مطابق للقديم بالحرف** (متوافق رجوعيًا ١٠٠٪).
 *
 *   employees[] / types[] → قوايم (multi-select إلزامي في أي شاشة فيها جدول)
 *   employee / type       → قيمة واحدة — متسابة للتوافق الرجعي
 *   dateFrom / dateTo     → بيتقارنوا بـ substr(timestamp,1,10) يعني **UTC**،
 *                           والعرض بتوقيت القاهرة. فرق الساعتين/التلاتة ممكن
 *                           يحط عملية بالليل في يوم UTC اللي بعده — مقبول
 *                           لفلتر بالأيام، بس مكتوب عشان مايتكتشفش كباج بعدين.
 */
function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
  search    = null,
  dateFrom  = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) {
    sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps);
  }
  if (typs.length) {
    sql += ` AND type IN (${typs.map(() => '?').join(',')})`; b.push(...typs);
  }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }

  return { sql, b };
}

// ⚠️ قائمة **مقفولة** — القيمة جاية من العميل وبتتلزق في نص SQL مباشرةً
//    (ORDER BY مابيقبلش bind). أي قيمة بره القايمة بترجع للافتراضي بدون خطأ.
// ⚠️ المفاتيح لازم تطابق `data-sort-key` في الواجهة **حرفيًا**.
const LOG_SORT_COLUMNS = {
  date: 'timestamp', time: 'timestamp', employee: 'employee',
  orderName: 'order_name', type: 'type',
};

function orderByClause(sortBy, sortDir) {
  const col = LOG_SORT_COLUMNS[String(sortBy || '')] || 'timestamp';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 🔴 كاسر تعادل إلزامي: من غيره صفوف نفس القيمة بترتيب عشوائي بين الصفحات،
  //    والصف الواحد ممكن يظهر في صفحتين **أو مايظهرش خالص**.
  return col === 'timestamp' ? ` ORDER BY timestamp ${dir}`
                             : ` ORDER BY ${col} ${dir}, timestamp DESC`;
}

async function getLogs(db, { limit = 100, offset = 0, sortBy, sortDir, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + orderByClause(sortBy, sortDir) + ' LIMIT ? OFFSET ?';
  return (await db.prepare(q)
    .bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

/**
 * ⚠️ بتقص عند LOG_EXPORT_MAX **في السكوت** — فالـ endpoint لازم يرجّع
 * cap و total و truncated كمان، وإلا الواجهة بتقول "تم التصدير ✓" على ملف ناقص.
 */
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  // التصدير والعدّ بيتجاهلوا الترتيب عن قصد — التصدير بياخد ترتيب السيرفر الافتراضي.
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

/**
 * بيقرا فلاتر السجل من الـ query string — CSV للقوايم
 * (employees=ahmed,sara · types=created,error). الاسم المفرد لسه مقبول.
 */
function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  return {
    tool,
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    type:      url.searchParams.get('type')     || null,
    search:    url.searchParams.get('search')   || null,
    dateFrom:  url.searchParams.get('dateFrom') || null,
    dateTo:    url.searchParams.get('dateTo')   || null,
  };
}

/**
 * متغيّر ناقص لازم يوقف العملية **برسالة باسمه** — مش يفشل جوه استعلام
 * برسالة غامضة بعدين.
 */
function assertEnv(env, names) {
  const missing = names.filter(n => !env[n]);
  if (missing.length) {
    throw new Error(`متغيّرات ناقصة في الـ Worker: ${missing.join(', ')} — راجع الداشبورد ثم Promote`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// END §SHARED
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// §SHOPIFY — OAuth + GraphQL helpers
// ══════════════════════════════════════════════════════════════════════

// ─── §SHOPIFY::fetchWithTimeout ────────────────────────────────────────
/**
 * ⚠️ v2.2.0 — إضافة حماية أساسية
 * ctx.waitUntil() بيدّي 30 ثانية بس (wall-clock) بعد الرد قبل ما Cloudflare
 * يوقف التنفيذ بالقوة — من غير ما يدّي الكود فرصة يعمل catch أو يسجّل أي
 * حاجة في D1 (موثّق رسمياً: developers.cloudflare.com/workers/platform/limits).
 * لو أي نداء لـ Shopify/WooCommerce اتأخر، أحسن نفشل إحنا بأنفسنا بـ
 * timeout متحكم فيه (يتسجل صح في D1) بدل ما ننتظر Cloudflare توقفنا
 * بالقوة من برّه من غير أي أثر.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(env) {
  const resp = await fetchWithTimeout(
    `https://${env.SHOP_DOMAIN}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
        grant_type:    'client_credentials',
      }),
    }
  );
  if (!resp.ok) throw new Error(`OAuth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error('No access_token in OAuth response');
  return data.access_token;
}

async function shopifyGQL(env, token, query, variables = {}) {
  const resp = await fetchWithTimeout(
    `https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  return resp.json();
}

// ══════════════════════════════════════════════════════════════════════
// §WEBHOOK — WC HMAC verification + idempotency + order processing
// ══════════════════════════════════════════════════════════════════════

// ─── §WEBHOOK::verifyWCSignature ──────────────────────────────────────
/**
 * Verify WooCommerce HMAC-SHA256 webhook signature
 * Header: X-WC-Webhook-Signature = base64(HMAC-SHA256(rawBody, secret))
 * Must be computed on raw bytes — NOT re-serialized JSON
 */
async function verifyWCSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const computedBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const computedBase64 = btoa(String.fromCharCode(...new Uint8Array(computedBuffer)));
  return computedBase64 === signature;
}

// ─── §WEBHOOK::address helpers ────────────────────────────────────────

// provinceCode (Shopify) → اسم المحافظة — للـ city fallback لو WC city فاضي
const EG_PROVINCE_NAMES = {
  ALX: 'Alexandria',  ASN: 'Aswan',       AST: 'Asyut',
  BA:  'Red Sea',     BH:  'Beheira',     BNS: 'Beni Suef',
  C:   'Cairo',       DK:  'Dakahlia',    DT:  'Damietta',
  FYM: 'Faiyum',      GH:  'Gharbia',     GZ:  'Giza',
  IS:  'Ismailia',    JS:  'South Sinai', KB:  'Qalyubia',
  KFS: 'Kafr el-Sheikh', KN: 'Qena',      LX:  'Luxor',
  MN:  'Minya',       MNF: 'Monufia',     MT:  'Matrouh',
  PTS: 'Port Said',   SHR: 'Sharqia',     SHG: 'Sohag',
  SIN: 'North Sinai', SUZ: 'Suez',        WAD: 'New Valley',
};

/**
 * WC state code "EGIS" → Shopify provinceCode "IS"
 * Pattern: strip "EG" prefix
 */
function toProvinceCode(wcState) {
  if (!wcState) return '';
  return wcState.startsWith('EG') ? wcState.slice(2) : wcState;
}

/**
 * Normalize Egyptian phone to international format
 * 01xxxxxxxxx → +201xxxxxxxxx
 */
function normalizePhone(phone) {
  if (!phone) return '';
  const clean = phone.replace(/[\s\-\(\)]/g, '');
  if (clean.startsWith('01') && clean.length === 11) return '+2' + clean;
  if (clean.startsWith('201'))  return '+' + clean;
  if (clean.startsWith('+'))    return clean;
  return phone;
}

/**
 * Convert WooCommerce billing/shipping address → Shopify MailingAddressInput
 * Handles: empty city (fallback to province name), phone normalization,
 * province code, and HTML entity decoding (v2.3.1 — راجع ملاحظة أعلى الملف)
 */
function buildAddress(wcAddr) {
  const provinceCode = toProvinceCode(wcAddr.state);
  const city = decodeHtmlEntities(wcAddr.city?.trim())
    || EG_PROVINCE_NAMES[provinceCode]  // fallback: اسم المحافظة
    || '';

  return {
    firstName:    decodeHtmlEntities(wcAddr.first_name)  || '',
    lastName:     decodeHtmlEntities(wcAddr.last_name)   || '',
    address1:     decodeHtmlEntities(wcAddr.address_1)   || '',
    address2:     decodeHtmlEntities(wcAddr.address_2)   || '',
    city,
    provinceCode,
    countryCode:  'EG',
    zip:          wcAddr.postcode    || '',
    phone:        normalizePhone(wcAddr.phone),
  };
}

// ─── §WEBHOOK::getWCUnitPrice ─────────────────────────────────────────
/**
 * يحسب سعر الوحدة الفعلي من بيانات WC line item
 * item.total = "Line total (after discounts)" — موثق رسميًا في WooCommerce
 * REST API schema، ومستثنى الضريبة دايمًا (فيه total_tax منفصل)
 * بيرجع decimal string (2 خانات) — متوافق مع MoneyInput.amount (Decimal!)
 * ويتجنب أي مشاكل floating point عند تمرير القيمة لـ GraphQL
 *
 * مصدر: WooCommerce REST API official schema —
 * https://github.com/woocommerce/woocommerce-rest-api-docs
 */
function getWCUnitPrice(item, idx) {
  const qty   = Number(item.quantity);
  const total = parseFloat(item.total);
  if (!qty || qty <= 0 || isNaN(total)) {
    throw new Error(
      `Line item ${idx + 1} (${item.name || item.sku}) — ` +
      `WC total/quantity غير صالح (total=${item.total}, qty=${item.quantity})`
    );
  }
  return (total / qty).toFixed(2);
}

// ─── GraphQL Queries / Mutations ──────────────────────────────────────

const CUSTOMER_BY_EMAIL_QUERY = `
  query CustomerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      edges { node { id } }
    }
  }
`;

const CUSTOMER_CREATE_MUTATION = `
  mutation CustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_CREATE_MUTATION = `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_COMPLETE_MUTATION = `
  mutation DraftOrderComplete($id: ID!, $paymentGatewayId: ID, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentGatewayId: $paymentGatewayId, paymentPending: $paymentPending) {
      draftOrder {
        order {
          id
          name
          displayFinancialStatus
          displayFulfillmentStatus
        }
      }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace value }
      userErrors { field message }
    }
  }
`;

// ─── §WEBHOOK::findOrCreateCustomer ──────────────────────────────────
/**
 * Lookup sequence:
 * 1. Search by email
 * 2. Search by normalized phone
 * 3. Create new customer
 * Returns: Shopify customer GID or null
 *
 * ⚠️ v2.0.0: الإيميل والتليفون بيتحطوا جوه quotes (email:"...") قبل ما
 * يدخلوا الـ Shopify search query — عشان أي حرف خاص (زي "+" في إيميلات
 * جيميل alias) ميتفسّرش كـ query syntax operator بالغلط.
 *
 * ⚠️ v2.3.1: firstName/lastName بتتعمل لهم decodeHtmlEntities() قبل
 * customerCreate — نفس مشكلة الـ &amp; ممكن تيجي في الاسم مش بس العنوان.
 */
async function findOrCreateCustomer(env, token, billing) {
  const email = billing.email?.trim() || '';
  const phone = normalizePhone(billing.phone);

  // 1. Search by email
  if (email) {
    const res = await shopifyGQL(env, token, CUSTOMER_BY_EMAIL_QUERY,
      { query: `email:"${email}"` });
    const found = res.data?.customers?.edges?.[0]?.node;
    if (found) return found.id;
  }

  // 2. Search by phone (fallback — for existing Shopify customers with phone only)
  if (phone) {
    const res = await shopifyGQL(env, token, CUSTOMER_BY_EMAIL_QUERY,
      { query: `phone:"${phone}"` });
    const found = res.data?.customers?.edges?.[0]?.node;
    if (found) return found.id;
  }

  // 3. Create new customer
  const createInput = {
    firstName: decodeHtmlEntities(billing.first_name) || '',
    lastName:  decodeHtmlEntities(billing.last_name)  || '',
  };
  if (email) createInput.email = email;
  if (phone) createInput.phone = phone;

  const res = await shopifyGQL(env, token, CUSTOMER_CREATE_MUTATION,
    { input: createInput });
  return res.data?.customerCreate?.customer?.id || null;
}

// ─── §WEBHOOK::buildDraftInput ────────────────────────────────────────
/**
 * Build DraftOrderInput from WooCommerce order body
 * Throws if any line item is missing global_unique_id
 *
 * §PRICING: كل line item بياخد priceOverride بسعر الوحدة الفعلي من WC
 * (item.total / item.quantity) — يضمن إن سعر المنتج في الأوردر على Shopify
 * يكون مطابق تمامًا لسعر WooCommerce وقت البيع، حتى لو كتالوج Shopify مختلف
 * (أعلى أو أقل). الـ override بيتطبق دايمًا — مش conditional — عشان نضمن
 * التطابق 100% بدون الحاجة لاستدعاء Shopify لمعرفة سعر الكتالوج الحالي.
 *
 * مصدر priceOverride field: Shopify GraphQL Admin API — DraftOrderLineItemInput
 * متاح من API version 2025-01 فصاعدًا (2026-01 مدعوم بالكامل) —
 * https://shopify.dev/docs/api/admin-graphql/latest/input-objects/draftorderlineiteminput
 */
function buildDraftInput(body, customerId) {
  // Line items — requiresShipping: true مطلوبة صراحةً لكل line item
  const lineItems = body.line_items.map((item, idx) => {
    const gtin = item.global_unique_id;
    if (!gtin) {
      throw new Error(
        `Line item ${idx + 1} (${item.name || item.sku}) missing global_unique_id — ` +
        `product not synced to WooCommerce yet`
      );
    }
    return {
      variantId:        `gid://shopify/ProductVariant/${gtin}`,
      quantity:         item.quantity,
      requiresShipping: true,   // ← إلزامي — بدونه يظهر "Shipping not required"
      priceOverride: {
        amount:       getWCUnitPrice(item, idx),
        currencyCode: STORE_CURRENCY,
      },
    };
  });

  // Shipping address: استخدم shipping لو موجود، وإلا billing
  const wcShipping = body.shipping?.address_1?.trim()
    ? body.shipping
    : body.billing;

  const input = {
    lineItems,
    shippingAddress: buildAddress(wcShipping),
    billingAddress:  buildAddress(body.billing),
    // بدون shippingLine — قرار Ahmed: نسيبها فاضية
    // _worker_clone: يمنع Shopify Flow من عمل clone للـ draft ده
    tags: ['StyleBox', '_worker_clone'],
  };

  if (customerId) input.customerId = customerId;
  if (body.billing.email?.trim()) input.email = body.billing.email.trim();

  // ── ملاحظة العميل ── (v2.3.2 — كانت مفقودة بالكامل، customer_note
  // من WooCommerce متربطش أبداً بـ DraftOrderInput.note قبل كده)
  if (body.customer_note?.trim()) {
    input.note = decodeHtmlEntities(body.customer_note.trim());
  }

  return input;
}

// ─── §WEBHOOK::idempotency ledger ─────────────────────────────────────
/**
 * حماية حقيقية ضد تكرار الأوردر على Shopify — عمود wc_order_id UNIQUE
 * (PRIMARY KEY) في جدول منفصل، بدل LIKE-search على عمود notes النصي.
 *
 * الأداة بتستقبل order.updated (مش order.created) — والـ topic ده ممكن
 * يتفعّل أكتر من مرة لنفس الأوردر (أي تعديل تاني وهو لسه processing).
 * فالحماية هنا لازم تكون idempotent فعلياً مش بس "غالباً هتشتغل".
 *
 * الحالات:
 *  in_progress → محجوز الآن (معالجة شغالة أو معالجة سابقة معلّقة)
 *  completed   → خلص بنجاح — أي محاولة تانية تتجاهل نهائياً
 *  failed      → فشلت محاولة سابقة — قابلة لإعادة المحاولة عند webhook تاني
 *
 * claimOrder بيستخدم INSERT OR IGNORE (عملية واحدة atomic) فمفيش نافذة
 * سباق بين "check" و"write" زي الأسلوب القديم.
 *
 * ⚠️ v2.2.0 — STALE_IN_PROGRESS_MS: لو Cloudflare قفل التنفيذ بالقوة
 * (بعد انتهاء مهلة الـ 30 ثانية بتاعة ctx.waitUntil) قبل ما الكود يوصل
 * لـ catch أصلاً، الصف بيفضل عالق على in_progress للأبد من غير الحماية
 * دي. أي صف in_progress عدّى عليه أكتر من 3 دقايق بيتعتبر تلقائياً stale
 * وقابل لإعادة المطالبة — أمان نهائي حتى لو حصل نفس السيناريو تاني.
 */
const STALE_IN_PROGRESS_MS = 3 * 60 * 1000; // 3 دقايق

async function claimOrder(db, wcOrderId) {
  const now = new Date().toISOString();

  const insertResult = await db.prepare(
    `INSERT OR IGNORE INTO wc_order_sync_ledger (wc_order_id, status, claimed_at)
     VALUES (?, 'in_progress', ?)`
  ).bind(wcOrderId, now).run();

  if (insertResult.meta.changes === 1) {
    return { claimed: true, retried: false };
  }

  // الصف موجود بالفعل — نشوف حالته
  const existing = await db.prepare(
    `SELECT status, claimed_at FROM wc_order_sync_ledger WHERE wc_order_id = ?`
  ).bind(wcOrderId).first();

  const isStaleInProgress = existing?.status === 'in_progress'
    && (Date.now() - new Date(existing.claimed_at).getTime()) > STALE_IN_PROGRESS_MS;

  if (existing?.status === 'failed' || isStaleInProgress) {
    // optimistic lock على claimed_at القديم — لو حد تاني كسب السباق في
    // نفس اللحظة، الـ UPDATE هنا هيرجع 0 changes ومنسحب بأمان
    const reclaim = await db.prepare(
      `UPDATE wc_order_sync_ledger SET status = 'in_progress', claimed_at = ?
       WHERE wc_order_id = ? AND status = ? AND claimed_at = ?`
    ).bind(now, wcOrderId, existing.status, existing.claimed_at).run();
    if (reclaim.meta.changes === 1) {
      return { claimed: true, retried: true };
    }
  }

  return { claimed: false, existingStatus: existing?.status ?? 'unknown' };
}

async function markOrderCompleted(db, wcOrderId, shopifyOrderId, shopifyOrderName) {
  await db.prepare(
    `UPDATE wc_order_sync_ledger
     SET status = 'completed', shopify_order_id = ?, shopify_order_name = ?, completed_at = ?
     WHERE wc_order_id = ?`
  ).bind(shopifyOrderId, shopifyOrderName, new Date().toISOString(), wcOrderId).run();
}

async function markOrderFailed(db, wcOrderId) {
  await db.prepare(
    `UPDATE wc_order_sync_ledger SET status = 'failed' WHERE wc_order_id = ?`
  ).bind(wcOrderId).run();
}

// ─── §WEBHOOK::processOrder (webhook entry point) ─────────────────────
/**
 * Main webhook processing function — called inside ctx.waitUntil()
 * بيفلتر على status === 'processing' بس، وبعدين يسلّم الشغل لـ
 * syncOrderToShopify
 *
 * v2.0.0 — التغييرات الأساسية:
 * 1. الفلتر بقى على status === 'processing' بدل 'completed' (راجع شرح
 *    أعلى الملف ليه — order.updated مش order.created)
 * 2. الحماية من التكرار بقت claimOrder/markOrderCompleted/markOrderFailed
 *    (D1 unique key حقيقي) بدل LIKE-search على notes
 */
async function processOrder(rawBody, env) {
  let body;

  // ── Parse JSON ─────────────────────────────────────────────────────
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    await writeLog(env.DB, {
      tool:  TOOL_NAME,
      type:  'error',
      notes: `JSON parse failed: ${e.message}`,
    }).catch(() => {});
    return;
  }

  // ── فلتر الحالة — بس لحظة الانتقال لـ processing ────────────────────
  // order.updated بيتفعّل لأي تعديل على الأوردر (مش بس status) — فمعظم
  // الأحداث هتترفض هنا بصمت، وده متوقع وطبيعي، مش خطأ.
  if (body.status !== 'processing') return;

  if (!body.id) {
    await writeLog(env.DB, {
      tool:  TOOL_NAME,
      type:  'error',
      notes: 'Webhook body missing order id (status=processing)',
    }).catch(() => {});
    return;
  }

  await syncOrderToShopify(body, env);
}

// ─── §WEBHOOK::syncOrderToShopify (core) ──────────────────────────────
/**
 * المنطق الفعلي لكل حاجة بعد الفلترة: idempotency claim → Shopify draft
 * order → complete → metafield → log. مُستخدمة من processOrder (تلقائي).
 */
async function syncOrderToShopify(body, env) {
  const wcOrderId  = body.id;
  const wcOrderNum = body.number;

  // ── Idempotency claim (atomic) ──────────────────────────────────────
  const claim = await claimOrder(env.DB, wcOrderId);
  if (!claim.claimed) {
    await writeLog(env.DB, {
      tool:  TOOL_NAME,
      type:  'skipped',
      notes: `WC #${wcOrderId} — already ${claim.existingStatus}`,
      extra: { wc_order_id: wcOrderId },
    });
    return;
  }

  try {
    // ── Shopify OAuth token ──────────────────────────────────────────
    const token = await getAccessToken(env);

    // ── Customer lookup / create ─────────────────────────────────────
    const customerId = await findOrCreateCustomer(env, token, body.billing);

    // ── Build draft order input (يشمل priceOverride لكل line item) ───
    // ⚠️ ممكن يرمي error (مثلاً منتج لسه من غير global_unique_id) —
    // هيتمسك في catch تحت ويتعمله markOrderFailed (قابل لإعادة المحاولة)
    const draftInput = buildDraftInput(body, customerId);

    // ── draftOrderCreate ──────────────────────────────────────────────
    const draftResult = await shopifyGQL(
      env, token, DRAFT_ORDER_CREATE_MUTATION, { input: draftInput }
    );
    const draftErrors = draftResult.data?.draftOrderCreate?.userErrors;
    if (draftErrors?.length) {
      throw new Error(`draftOrderCreate failed: ${JSON.stringify(draftErrors)}`);
    }
    const draftId = draftResult.data?.draftOrderCreate?.draftOrder?.id;
    if (!draftId) {
      throw new Error(`no draftId returned — raw: ${JSON.stringify(draftResult).slice(0, 400)}`);
    }

    // ── draftOrderComplete → real order with COD gateway ──────────────
    const completeResult = await shopifyGQL(
      env, token, DRAFT_ORDER_COMPLETE_MUTATION, {
        id:               draftId,
        paymentGatewayId: env.COD_GATEWAY_ID || COD_GATEWAY_GID,
        paymentPending:   true,
      }
    );
    const completeErrors = completeResult.data?.draftOrderComplete?.userErrors;
    if (completeErrors?.length) {
      throw new Error(`draftOrderComplete failed: ${JSON.stringify(completeErrors)}`);
    }
    const order = completeResult.data?.draftOrderComplete?.draftOrder?.order;
    if (!order) {
      throw new Error(`no order returned after complete — draftId: ${draftId}`);
    }

    // ── Set WooCommerce order ID metafield ────────────────────────────
    await shopifyGQL(env, token, METAFIELDS_SET_MUTATION, {
      metafields: [{
        ownerId:   order.id,
        namespace: 'custom',
        key:       'stylebox_order_id',
        value:     String(wcOrderId),  // number_integer يقبل string
        type:      'number_integer',
      }]
    });

    // ── Success — mark ledger + write log ─────────────────────────────
    const shopifyNumericId = order.id.replace('gid://shopify/Order/', '');
    const lineItemPrices = body.line_items.map((li, idx) => ({
      sku:           li.sku || null,
      qty:           li.quantity,
      wc_unit_price: getWCUnitPrice(li, idx),
    }));

    await markOrderCompleted(env.DB, wcOrderId, shopifyNumericId, order.name);

    await writeLog(env.DB, {
      tool:      TOOL_NAME,
      type:      'created',
      orderId:   shopifyNumericId,
      orderName: order.name,
      notes:     `WC #${wcOrderId} → ${order.name}`,
      extra: {
        wc_order_id:        wcOrderId,
        wc_order_num:       wcOrderNum,
        wc_total:           body.total,
        shopify_order_id:   order.id,
        shopify_order_name: order.name,
        financial_status:   order.displayFinancialStatus,
        customer_email:     body.billing.email || null,
        customer_phone:     normalizePhone(body.billing.phone),
        line_item_prices:   lineItemPrices,
        retried_after_failure: claim.retried,
      },
    });

  } catch (e) {
    // ── أي فشل هنا → failed (قابل لإعادة المحاولة) + log ───────────────
    await markOrderFailed(env.DB, wcOrderId).catch(() => {});
    await writeLog(env.DB, {
      tool:  TOOL_NAME,
      type:  'error',
      notes: `WC #${wcOrderId} — ${e.message}`,
      extra: { wc_order_id: wcOrderId, wc_order_num: wcOrderNum, stack: e.stack?.slice(0, 500) },
    }).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    // ── OPTIONS preflight ──────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCORSHeaders() });
    }

    // ─── §WEBHOOK ─────────────────────────────────────────────────
    // WooCommerce يبعت POST بدون action param (Topic: Order updated)
    if (request.method === 'POST' && !action) {

      // لازم نقرأ raw body الأول (قبل JSON.parse) عشان الـ HMAC صح
      const rawBody   = await request.text();
      const signature = request.headers.get('x-wc-webhook-signature') || '';

      // WooCommerce بيبعت unsigned ping لما بتعمل Save على الـ webhook
      // مفيش signature = ping = acknowledge فقط بدون processing
      if (!signature) {
        return new Response('OK', { status: 200 });
      }

      // ── HMAC verification ──────────────────────────────────────
      let valid = false;
      try {
        valid = await verifyWCSignature(rawBody, signature, env.WC_WEBHOOK_SECRET);
      } catch (_) {
        return new Response('Unauthorized', { status: 401 });
      }

      if (!valid) {
        return new Response('Unauthorized', { status: 401 });
      }

      // ── رد 200 فوراً (WooCommerce عنده timeout قصير) ──────────
      // كل الشغل الفعلي في ctx.waitUntil — بعيداً عن الـ response
      ctx.waitUntil(processOrder(rawBody, env));
      return new Response('OK', { status: 200 });
    }
    // ─────────────────────────────────────────────────────────────

    // ── كل الـ endpoints التانية: WORKER_SECRET مطلوب ─────────────
    // 🔴 السر الناقص بيترد عليه برسالة باسمه — مش 401 غامض. من غير الحارس
    //    ده، سر اتضاف من غير Promote بيدّي "Unauthorized" على كل نداء
    //    والموظف بيدوّر في المكان الغلط.
    if (!env.WORKER_SECRET) {
      return json({ ok: false, error: 'WORKER_SECRET ناقص في الـ Worker — ضيفه في Settings → Variables and Secrets ثم Promote', step: 'env' }, 500);
    }
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader !== `Bearer ${env.WORKER_SECRET}`) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    try {
      // ─── §CONFIG-ENDPOINTS ────────────────────────────────────────

      // حارس نسخة الـ Worker في الواجهة بيقرا من هنا (Promote ناقص / Worker شبح)
      if (action === 'get_config') {
        return json({ ok: true, version: WORKER_VERSION, tool: TOOL_NAME });
      }

      // فحص ذاتي — بدون أي كتابة. ⚠️ ممنوع يعرض قيمة أي سر: أسماء وأطوال بس.
      if (action === 'diag') {
        const checks = [];
        const envKeys = Object.keys(env).sort().map(k => ({
          name:   k,
          type:   typeof env[k],
          // الطول بيكشف المسافة المخفية في آخر السر — من غير ما يعرض القيمة
          length: typeof env[k] === 'string' ? env[k].length : null,
        }));

        for (const name of ['WORKER_SECRET', 'WC_WEBHOOK_SECRET', 'CLIENT_ID', 'CLIENT_SECRET']) {
          checks.push({
            ok:     !!env[name],
            label:  name,
            detail: env[name]
              ? `موجود — الطول ${String(env[name]).length} حرف`
              : 'ناقص — ضيفه في Settings → Variables and Secrets ثم Promote',
          });
        }
        checks.push({
          ok:     !!env.SHOP_DOMAIN,
          label:  'SHOP_DOMAIN',
          detail: env.SHOP_DOMAIN ? String(env.SHOP_DOMAIN) : 'ناقص — راجع [vars] في wrangler.toml',
        });
        checks.push({
          ok:     !!env.COD_GATEWAY_ID,
          label:  'COD_GATEWAY_ID',
          detail: env.COD_GATEWAY_ID
            ? String(env.COD_GATEWAY_ID)
            : `غير مضبوط — الكود بيرجع للقيمة الافتراضية (${COD_GATEWAY_GID}). المتغيّر ده ليه fallback، فغيابه مابيوقّفش الأداة`,
        });
        checks.push({
          ok:     !!env.DB,
          label:  'D1 binding (DB)',
          detail: env.DB ? 'موجود في wrangler.toml' : 'ناقص — راجع [[d1_databases]] في wrangler.toml',
        });

        try {
          const row = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM logs WHERE tool = ?'
          ).bind(TOOL_NAME).first();
          checks.push({ ok: true, label: 'جدول logs', detail: `${row?.n ?? 0} صف باسم الأداة (tool = '${TOOL_NAME}')` });
        } catch (e) {
          checks.push({ ok: false, label: 'جدول logs', detail: `فشل الاستعلام: ${e.message}` });
        }

        try {
          const row = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM wc_order_sync_ledger'
          ).first();
          checks.push({ ok: true, label: 'جدول wc_order_sync_ledger', detail: `${row?.n ?? 0} صف — سجل الحماية من التكرار` });
        } catch (e) {
          checks.push({ ok: false, label: 'جدول wc_order_sync_ledger', detail: `فشل الاستعلام: ${e.message}` });
        }

        try {
          const row = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM employees WHERE is_active = 1'
          ).first();
          checks.push({ ok: true, label: 'جدول employees', detail: `${row?.n ?? 0} موظف نشط` });
        } catch (e) {
          checks.push({ ok: false, label: 'جدول employees', detail: `فشل الاستعلام: ${e.message}` });
        }

        checks.push({
          ok:     true,
          label:  'CORS',
          detail: `wildcard * — الأداة قراءة فقط من الواجهة، والحماية في WORKER_SECRET. الطلب جاي من ${request.headers.get('Origin') || '(بدون Origin)'}`,
        });

        return json({ ok: true, version: WORKER_VERSION, tool: TOOL_NAME, envKeys, checks });
      }

      assertEnv(env, ['DB']);

      // ─── §AUTH-ENDPOINTS — Universal D1 Auth ──────────────────────

      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results });
      }

      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400);
        const result = await checkEmployee(env.DB, username);
        return json({ ok: true, ...result });
      }

      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400);
        await registerPin(env.DB, username, pin);
        return json({ ok: true });
      }

      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
        const { username, pin, appId } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400);

        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401);

        // ⚠️ الدخول نفسه نجح فعلاً فوق. فشل D1 بعد كده بيترجع كـ logged:false —
        //    مش بيسقّط الرد كله على 500 لدخول حصل فعلاً.
        let logged = true;
        try {
          await writeLog(env.DB, {
            tool:     resolveAuthTool(appId),
            type:     'login',
            employee: username,
            notes:    `دخول: ${displayName}`,
          });
        } catch (_) { logged = false; }

        return json({ ok: true, displayName, logged });
      }

      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        const appId    = url.searchParams.get('appId');
        let logged = true;
        if (username) {
          try {
            await writeLog(env.DB, {
              tool:     resolveAuthTool(appId),
              type:     'logout',
              employee: username,
              notes:    `خروج: ${username.replace(/_/g, ' ')}`,
            });
          } catch (_) { logged = false; }
        }
        return json({ ok: true, logged });
      }

      // ─── §LOG-ENDPOINTS — Log Filter Model v2 ─────────────────────

      if (action === 'get_logs') {
        const p = logParamsFrom(url, TOOL_NAME);
        // 🔴 parseInt('abc') → NaN → بيوصل D1 كـ bind ويرجّع خطأ غامض.
        const limitRaw  = parseInt(url.searchParams.get('limit')  || '100', 10);
        const offsetRaw = parseInt(url.searchParams.get('offset') || '0',   10);
        const limit  = Number.isFinite(limitRaw)  ? Math.min(Math.max(limitRaw, 1), 100) : 100;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

        const entries = await getLogs(env.DB, {
          ...p, limit, offset,
          sortBy:  url.searchParams.get('sortBy'),
          sortDir: url.searchParams.get('sortDir'),
        });
        return json({ ok: true, entries });
      }

      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logParamsFrom(url, TOOL_NAME));
        return json({ ok: true, total });
      }

      if (action === 'get_logs_export') {
        const p = logParamsFrom(url, TOOL_NAME);
        const [entries, total] = await Promise.all([
          getLogsExport(env.DB, p),
          getLogsCount(env.DB, p),   // العدّ الحقيقي جنب الصفوف — بنفس الفلاتر بالظبط
        ]);
        return json({ ok: true, entries, cap: LOG_EXPORT_MAX, total,
                      truncated: total > LOG_EXPORT_MAX });
      }

      // ─── §VIEW-ENDPOINTS — أرقام شاشة العرض ───────────────────────

      /**
       * ملخّص الفترة + الفترة السابقة (بنفس الطول) + حالة الـ ledger الحالية.
       * ⚠️ صفوف الـ logs **أحداث** (اللي حصل وقتها ما بيتغيّرش)، أما الـ ledger
       *    فحالة حالية — عشان كده الاتنين بيرجعوا منفصلين ومش بيتكاشوا.
       */
      if (action === 'get_summary') {
        const dateFrom = url.searchParams.get('dateFrom') || null;
        const dateTo   = url.searchParams.get('dateTo')   || null;

        const countsFor = async (from, to) => {
          let sql = 'SELECT type, COUNT(*) AS n FROM logs WHERE tool = ?';
          const b = [TOOL_NAME];
          if (from) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(from); }
          if (to)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(to); }
          sql += ' GROUP BY type';
          const { results } = await env.DB.prepare(sql).bind(...b).all();
          const out = { created: 0, skipped: 0, error: 0 };
          for (const r of results) out[r.type] = r.n;
          return out;
        };

        // الفترة السابقة = نفس عدد الأيام، ملزوقة قبل الفترة الحالية
        let prevFrom = null, prevTo = null;
        if (dateFrom && dateTo) {
          const MS_DAY = 24 * 60 * 60 * 1000;
          const f = Date.parse(`${dateFrom}T00:00:00.000Z`);
          const t = Date.parse(`${dateTo}T00:00:00.000Z`);
          if (Number.isFinite(f) && Number.isFinite(t) && t >= f) {
            const days = Math.round((t - f) / MS_DAY) + 1;
            prevTo   = new Date(f - MS_DAY).toISOString().slice(0, 10);
            prevFrom = new Date(f - days * MS_DAY).toISOString().slice(0, 10);
          }
        }

        const staleBefore = new Date(Date.now() - STALE_LEDGER_MS).toISOString();

        const [counts, prev, ledgerRows, staleRow, lastRow] = await Promise.all([
          countsFor(dateFrom, dateTo),
          prevFrom ? countsFor(prevFrom, prevTo) : Promise.resolve(null),
          env.DB.prepare('SELECT status, COUNT(*) AS n FROM wc_order_sync_ledger GROUP BY status').all(),
          env.DB.prepare(
            "SELECT COUNT(*) AS n FROM wc_order_sync_ledger WHERE status = 'in_progress' AND claimed_at < ?"
          ).bind(staleBefore).first(),
          env.DB.prepare('SELECT MAX(timestamp) AS ts FROM logs WHERE tool = ?').bind(TOOL_NAME).first(),
        ]);

        const ledger = { completed: 0, failed: 0, in_progress: 0 };
        for (const r of ledgerRows.results) ledger[r.status] = r.n;

        return json({
          ok: true,
          version:     WORKER_VERSION,
          period:      { from: dateFrom, to: dateTo },
          prevPeriod:  prevFrom ? { from: prevFrom, to: prevTo } : null,
          counts,
          prev,
          ledger,
          staleInProgress: staleRow?.n ?? 0,
          lastEventAt:     lastRow?.ts ?? null,
          generatedAt:     new Date().toISOString(),
        });
      }

      /**
       * الصفوف المحتاجة انتباه: أي أوردر في الـ ledger حالته failed، أو
       * in_progress عدّى عليه أكتر من STALE_LEDGER_MS (يعني التنفيذ اتقطع).
       * ومعاها آخر رسالة خطأ لكل أوردر من الـ logs.
       */
      if (action === 'get_attention') {
        const staleBefore = new Date(Date.now() - STALE_LEDGER_MS).toISOString();
        const { results: rows } = await env.DB.prepare(
          `SELECT wc_order_id, status, claimed_at, shopify_order_id, shopify_order_name, completed_at
             FROM wc_order_sync_ledger
            WHERE status = 'failed' OR (status = 'in_progress' AND claimed_at < ?)
            ORDER BY claimed_at DESC LIMIT 100`
        ).bind(staleBefore).all();

        const ids = rows.map(r => String(r.wc_order_id));
        let lastErrors = {};
        if (ids.length) {
          const { results: errs } = await env.DB.prepare(
            `SELECT json_extract(extra, '$.wc_order_id') AS wc_order_id, notes, timestamp
               FROM logs
              WHERE tool = ? AND type = 'error'
                AND CAST(json_extract(extra, '$.wc_order_id') AS TEXT) IN (${ids.map(() => '?').join(',')})
              ORDER BY timestamp DESC`
          ).bind(TOOL_NAME, ...ids).all();
          for (const e of errs) {
            const k = String(e.wc_order_id);
            if (!lastErrors[k]) lastErrors[k] = { notes: e.notes, timestamp: e.timestamp };
          }
        }

        return json({
          ok: true,
          rows: rows.map(r => ({
            ...r,
            stale:     r.status === 'in_progress',
            lastError: lastErrors[String(r.wc_order_id)] || null,
          })),
          staleThresholdMs: STALE_LEDGER_MS,
          generatedAt:      new Date().toISOString(),
        });
      }

      // ─── Status check (للـ debugging والتأكد إن الـ Worker شغال) ──
      if (action === 'status') {
        return json({ ok: true, tool: TOOL_NAME, version: WORKER_VERSION, ts: new Date().toISOString() });
      }

      // ──────────────────────────────────────────────────────────────
      return json({ ok: false, error: 'Unknown action' }, 404);

    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  },
};
