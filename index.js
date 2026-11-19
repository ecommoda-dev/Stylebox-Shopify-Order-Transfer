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
//
// v2.5.0 — 12-09-2026 — ⚠️ إصلاح: مصاريف الشحن كانت بتضيع بالكامل
// السبب (مؤكد 100% من الكود + Shopify + D1): buildDraftInput() كانت
// بتبني الـ DraftOrderInput من غير shippingLine خالص (قرار قديم اتكتب
// وقت ما WooCommerce كان شحنه صفر على كل الأوردرات). Shopify **مابيحسبش**
// شحن لوحده للـ draft order — بياخد اللي تديهوله بس، فكل أوردر كان بيتقفل
// بـ shippingLines = [] و totalShippingPriceSet = 0.
//
// الباج كان **كامن** من أول يوم وما ظهرش غير لما stylebox.online فعّلت
// الـ Flat rate يوم 10-09-2026. الدليل من D1 — فرق (wc_total − مجموع
// الأصناف) على كل الـ 797 أوردر:
//   794 أوردر → 0     (WooCommerce نفسه كان شحنه صفر)
//     3 أوردر → 75/100/75   (#54220 · #54396 · #54425 — من 10-09 فما بعد)
// والفرق ده هو **بالظبط** قيمة الشحن الضايعة على شوبيفاي في كل مرة.
//
// الحل: buildShippingLine() بتضيف shippingLine **دايمًا** (قرار Ahmed
// 12-09-2026 — الشحن بصفر بيظهر كسطر بصفر، عشان كل الأوردرات الجديدة
// يبقى شكلها واحد). الأوردرات القديمة **مش بتتصلح تلقائيًا** — تتساب
// زي ما هي (نفس قرار v2.3.1 مع العناوين).
//
// ⚠️ الضرايب: shipping_total في WooCommerce **مش شامل** ضريبة الشحن
// (shipping_tax حقل منفصل). المتجر شغال من غير ضرايب نهائيًا وده قرار
// ثابت — لو اتغير في أي يوم، لازم يترجع للبند ده.
//
// v2.5.1 — 24-09-2026 — الطبقة ٥: الحارس الديناميكي لقيم اللوج (Step 7-ج
// في ecommoda-worker-builder). استبدال check-log-values.mjs بالنسخة
// المصلَّحة (كانت بتدوّر على `type:` بنقطتين بس، وobject shorthand زي
// `{ tool, type }` كان بيعدّي في صمت — مش الحالة هنا لأن كل نداء في الملف
// ده مكتوب صريح أصلاً، لكن التشيك اتستبدل زي ما هو مطلوب). §LOG-REG
// أضيف قبل §SHARED: LOG_REGISTRY مبني من log-values.json (٥ قيم، زوج
// tool/type)، والحارس اتحط في writeLog — مفيش رفض كتابة أبدًا، الصف
// بيتكتب عادي وعليه extra._unregistered لو القيمة مش مسجّلة + UPSERT
// صامت في log_value_alerts بعد الكتابة.
// v2.8.0 — 19-11-2026 — P2: حماية الأوردر العالق من التكرار (shopify_draft_id) — بند (٣) تحت.
// v2.7.0 — 19-11-2026 — حماية دايمة من global_unique_id الفاضي + تنضيف مدخلات شكلية:
// (١) P0: لو GTIN فاضي/مش رقمي الـ Worker بيحدد الـ variant على شوبيفاي بالـ SKU بتحقق رباعي
//     (SKU موجود · variant واحد بالظبط · SKU مطابق حرفيًا · custom.wordpress_variation_id = item.variation_id)
//     — فشل أي شرط = نفس الخطأ القديم + السبب (مفيش تخمين). المسار العادي (GTIN رقمي) صفر نداءات زيادة.
//     محتاج صلاحية read_products على التطبيق (بتتفحص في ?action=diag).
// (٢) P1: الرموز الرياضية في الاسم بتتشال · address1/address2 بتتقص على 255 والنص الكامل في note ·
//     إيميل بدومين غلط (userErrors كلها على email) → إعادة محاولة واحدة من غير إيميل. كله بتحذير في extra.warnings.
// (٣) [v2.8.0] P2: عمود shopify_draft_id في wc_order_sync_ledger — بيتكتب فورًا بعد draftOrderCreate (قبل الـ complete)،
//     وعند reclaim لصف عنده draft: استعلام draftOrder{status order} — لو اتكمّل → markOrderCompleted من غير أوردر جديد
//     (يمنع التكرار لو الـ Worker وقع بين draftOrderComplete وmarkOrderCompleted). الكود شغّال قبل وبعد الـ ALTER:
//     ALTER TABLE wc_order_sync_ledger ADD COLUMN shopify_draft_id TEXT;   (أحمد ينفّذها في D1 Console)
// v2.6.1 — 19-11-2026 — 🔴 إصلاح انحدار من v2.6.0: ربط العميل (findOrCreateCustomer) بقى best-effort —
// فشله (ACCESS_DENIED على write_customers) بقى warning والأوردر بيتكمّل، بدل ما يفشل كل الأوردرات.
// v2.6.0 — 18-11-2026 — مواءمة مع المهارات الحالية: (١) API 2026-01 → 2026-10
// بعد فحص كل وثيقة GraphQL على Shopify MCP؛ (٢) shopifyGQL بقت النسخة المعتمدة
// (Step 5A ① — كانت `return resp.json()` وبس) + التقاط تكلفة الاستعلام (⑮)؛
// (٣) getAccessToken بـ retry/backoff (⑯ ②)؛ (٤) `DraftOrderInput.customerId`
// (مُهمَل في 2026-10) → `purchasingEntity: { customerId }`؛ (٥) كتابة ميتافيلد
// `stylebox_order_id` بقت متأكَّد منها، وفشلها بعد اكتمال الأوردر = warning في
// السجل مش فشل (الفشل كان هيعيد المحاولة ويكرّر الأوردر على شوبيفاي — ⑩ ②)؛
// (٦) حارس WORKER_SECRET بـ typeof/trim.
// skills: worker-builder v4.2.0 · constants v6.0.1 · shopify-graphql-helper v3.2.0 · woocommerce-sync-helper v2.1.1 · html-builder v9.1.1 — 19-11-2026
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════════════
const TOOL_NAME         = 'wc_order_transfer';  // ⚠️ كان 'wc_sync' قبل كده — راجع ملاحظة الـ migration
const COD_GATEWAY_GID   = 'gid://shopify/PaymentGateway/125688283458';
const STORE_CURRENCY    = 'EGP';   // ⚠️ تأكد إن عملة المتجر على Shopify فعلاً EGP
const WORKER_VERSION    = 'v2.8.0';  // ← بيرجع في ?action=get_config — حارس الواجهة
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

// ─── §HELPERS::sanitizers (v2.7.0) ────────────────────────────────────
// شوبيفاي بترفض الاسم لو فيه رموز رياضية (\p{Sm}: + < = > | ~ …) — القاعدة: مانفشّلش أوردر بسبب بيانات شكلية.
function cleanName(str) {
  return String(decodeHtmlEntities(str) ?? '').replace(/\p{Sm}/gu, '').replace(/\s+/g, ' ').trim();
}

const ADDRESS_MAX = 255;   // حد شوبيفاي لـ address1/address2 (رسالة الخطأ: "exceeds maximum length of 255 characters")
// يقص على حدود كلمة لو أمكن (آخر مسافة في النص)، وإلا قص حرفي.
function truncateAtWord(str, max = ADDRESS_MAX) {
  if (!str || str.length <= max) return str || '';
  const cut = str.slice(0, max);
  const sp  = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

// ════════════════════════════════════════════════════════════
// §LOG-REG — الحارس الديناميكي لقيم اللوج (الطبقة ٥)
// ════════════════════════════════════════════════════════════
// قطعة الأداة دي بس من log-values.json اللي جنبها — بتتحدّث معاه في
// نفس الـ commit. ممنوع شحن السجل الكامل بتاع كل الأدوات هنا.
const LOG_REGISTRY = {
  wc_order_transfer: new Set(['login', 'logout', 'created', 'error', 'skipped']),
};

const isRegisteredLogValue = (tool, type) => !!LOG_REGISTRY[tool]?.has(type);

// UPSERT على (source_tool, tool, type) — صف واحد لكل قيمة، hits بيعدّ.
// الحدث الكامل مش بيضيع: الصف الأصلي موجود في logs وعليه _unregistered،
// والجدول ده فهرس مش سجل تاني — عشان كده dedupe مش صف لكل حدث.
const LOG_ALERT_SQL = `
  INSERT INTO log_value_alerts
    (source_tool, tool, type, first_seen, last_seen, hits,
     worker_version, sample_order_name, sample_employee, sample_notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_tool, tool, type) DO UPDATE SET
    last_seen         = excluded.last_seen,
    hits              = log_value_alerts.hits + excluded.hits,
    worker_version    = excluded.worker_version,
    sample_order_name = excluded.sample_order_name,
    sample_employee   = excluded.sample_employee,
    sample_notes      = excluded.sample_notes,
    status            = CASE WHEN log_value_alerts.status = 'ignored'
                             THEN 'ignored' ELSE 'open' END
`;

// فشل التنبيه ممنوع يأثر على أي حاجة — try/catch صامت. بتجمّع التكرار
// جوّه نفس الدفعة في صف واحد (hits) قبل ما تكتب.
async function noteUnregisteredLogValues(db, entries) {
  const byPair = new Map();
  for (const e of entries) {
    const key = `${e.tool}\u0000${e.type}`;
    const acc = byPair.get(key);
    if (acc) { acc.hits++; continue; }
    byPair.set(key, { entry: e, hits: 1 });
  }
  const now = new Date().toISOString();
  for (const { entry, hits } of byPair.values()) {
    try {
      await db.prepare(LOG_ALERT_SQL).bind(
        TOOL_NAME, entry.tool ?? '(بدون tool)', entry.type ?? '(بدون type)',
        now, now, hits, WORKER_VERSION ?? null,
        entry.orderName ?? null, entry.employee ?? null,
        entry.notes ? String(entry.notes).slice(0, 200) : null,
      ).run();
    } catch (e) { /* متعمّد: التنبيه فهرس، وفشله أهون من تعطيل الأداة */ }
  }
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
  // ⚠️ الحارس الديناميكي (الطبقة ٥ — §LOG-REG تحت) — مفيش رفض كتابة أبدًا.
  const unregistered = !isRegisteredLogValue(entry.tool, entry.type);
  const extra = unregistered
    ? { ...(entry.extra || {}), _unregistered: true }
    : entry.extra;

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
    extra ? JSON.stringify(extra) : null
  ).run();

  if (unregistered) await noteUnregisteredLogValues(db, [entry]);   // بعد الكتابة، مش قبلها
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

// §SHOPIFY::getAccessToken — التوكن والـ throttle bucket مشتركين بين كل Workers الستاك
// (نفس الـ Custom App)، فالفشل العابر لازم يتعافى (worker-builder Step 5A ⑯ ②).
// الاسم OAUTH_MAX_ATTEMPTS مقصود — وصفة الجرد بتدوّر عليه.
const OAUTH_MAX_ATTEMPTS = 3;

async function getAccessToken(env) {
  let lastErr = null;
  for (let attempt = 1; attempt <= OAUTH_MAX_ATTEMPTS; attempt++) {
    try {
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
      if (!resp.ok) {
        const retriable = resp.status === 429 || resp.status >= 500;
        lastErr = new Error(`OAuth failed: ${resp.status}`);
        if (retriable && attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
        throw lastErr;
      }
      const data = await resp.json();
      if (!data.access_token) throw new Error('No access_token in OAuth response');
      return data.access_token;
    } catch (e) {
      lastErr = e;
      if (attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('OAuth: unknown failure');
}

// ⑮ تكلفة الاستعلام — للقياس بس (صفر اعتماد من الواجهة): throttleStatus = الرصيد
//    المتبقي، actualQueryCost = النداء كلّف قد إيه.
let _lastThrottle  = null;
let _lastQueryCost = null;

// 🔴 النسخة المعتمدة (worker-builder Step 5A ①) — بترمي على: فشل شبكة · HTTP status ·
//    رد مش JSON · data.errors · data فاضية، + إعادة محاولة على THROTTLED.
//    النسخة القديمة كانت `return resp.json()` وبس: 401/429/5xx وأخطاء GraphQL العلوية
//    كانت بتعدّي كأنها رد سليم.
async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify', costLog = null) {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetchWithTimeout(
        `https://${env.SHOP_DOMAIN}/admin/api/2026-10/graphql.json`,
        {
          method:  'POST',
          headers: {
            'Content-Type':           'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ query, variables }),
        }
      );
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: فشل الاتصال بشوبيفاي — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }

    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: شوبيفاي ردّت HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw lastErr;
    }

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }

    if (Array.isArray(data.errors) && data.errors.length) {
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(
        `${opName}: ${data.errors.map(e => e.message).join(' | ')}` +
        (codes.length ? ` [${codes.join(',')}]` : '')
      );
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1200 * attempt)); continue;
      }
      throw lastErr;
    }

    if (!data.data) throw new Error(`${opName}: رد شوبيفاي بدون data — ${text.slice(0, 180)}`);
    const cost = data.extensions?.cost;
    if (cost) {
      if (cost.throttleStatus) _lastThrottle = cost.throttleStatus;
      _lastQueryCost = { op: opName, requested: cost.requestedQueryCost ?? null, actual: cost.actualQueryCost ?? null };
      if (costLog) costLog.push({ ..._lastQueryCost });
    }
    return data;
  }
  throw lastErr || new Error(`${opName}: فشل غير معروف`);
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
function buildAddress(wcAddr, opts = {}) {
  const { fallbackFirst = '', label = '', fullAddress = null } = opts;
  const provinceCode = toProvinceCode(wcAddr.state);
  const city = decodeHtmlEntities(wcAddr.city?.trim())
    || EG_PROVINCE_NAMES[provinceCode]  // fallback: اسم المحافظة
    || '';

  // v2.7.0 — اسم نضيف: رموز رياضية بتتشال؛ الأول لو فضي → اسم الفاتورة → "-"
  const firstName = cleanName(wcAddr.first_name) || cleanName(fallbackFirst) || '-';
  const lastName  = cleanName(wcAddr.last_name);

  // v2.7.0 — address1/address2 بحد 255؛ النص الكامل بيتجمّع في fullAddress عشان يروح note (الشحن بيعتمد عليه)
  const fit = (raw, field) => {
    const full = decodeHtmlEntities(raw) || '';
    if (full.length <= ADDRESS_MAX) return full;
    if (fullAddress) fullAddress.push({ label: `${label} ${field}`.trim(), full });
    return truncateAtWord(full);
  };

  return {
    firstName,
    lastName,
    address1:     fit(wcAddr.address_1, 'address1'),
    address2:     fit(wcAddr.address_2, 'address2'),
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

// كتابة custom.stylebox_order_id — بترمي لو شوبيفاي ما أكدتش (المستدعي بيحوّلها warning)
async function setOrderMetafield(env, token, orderGid, wcOrderId) {
  const mfRes = await shopifyGQL(env, token, METAFIELDS_SET_MUTATION, {
    metafields: [{
      ownerId:   orderGid,
      namespace: 'custom',
      key:       'stylebox_order_id',
      value:     String(wcOrderId),  // number_integer يقبل string
      type:      'number_integer',
    }]
  }, 'metafieldsSet(stylebox_order_id)');
  const mfErrs = mfRes.data?.metafieldsSet?.userErrors || [];
  if (mfErrs.length) throw new Error(mfErrs.map(e => e.message).join(' | '));
  if (!mfRes.data?.metafieldsSet?.metafields?.length) throw new Error('شوبيفاي ما أكدتش الميتافيلد');
}

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
    firstName: cleanName(billing.first_name),
    lastName:  cleanName(billing.last_name),
  };
  if (email) createInput.email = email;
  if (phone) createInput.phone = phone;

  const res = await shopifyGQL(env, token, CUSTOMER_CREATE_MUTATION,
    { input: createInput });
  return res.data?.customerCreate?.customer?.id || null;
}

// ─── §WEBHOOK::buildShippingLine ──────────────────────────────────────
/**
 * WooCommerce shipping → Shopify ShippingLineInput  (v2.5.0)
 *
 * ⚠️ Shopify بياخد **سطر شحن واحد بس** في الـ draft order — الحقل
 * `shippingLine` مفرد مش list. فالمبلغ بيتاخد من `shipping_total` (وده
 * رقم WooCommerce بيجمع فيه كل سطور الشحن، فلو فيه أكتر من سطر الفلوس
 * بتفضل مضبوطة)، والعنوان بيتاخد من أول سطر بس.
 *
 * السطر بيتضاف **دايمًا** حتى لو الشحن بصفر — قرار Ahmed 12-09-2026.
 *
 * ⚠️ `shipping_total` **مستثنى منه ضريبة الشحن** (`shipping_tax` حقل
 * منفصل في WooCommerce). المتجر من غير ضرايب وده قرار ثابت — أي تفعيل
 * للضرايب مستقبلاً بيخلي السطر ده ناقص.
 *
 * ⚠️ decodeHtmlEntities على العنوان لنفس سبب v2.3.1 — `method_title`
 * نص جاي من WooCommerce، وممكن يوصل بترميز HTML ("Delivery &amp; Handling").
 *
 * مصدر الحقول:
 *  · WooCommerce REST API v3 — order.shipping_total · order.shipping_lines[].method_title
 *  · Shopify GraphQL Admin 2026-10 — ShippingLineInput { priceWithCurrency, title }
 *    ⚠️ `price` (Money) في نفس الـ input **deprecated** — المستخدم هنا
 *    `priceWithCurrency` (MoneyInput) زي `priceOverride` بالظبط.
 */
function buildShippingLine(body) {
  const amount = parseFloat(body.shipping_total);
  return {
    title: decodeHtmlEntities(body.shipping_lines?.[0]?.method_title?.trim()) || 'Shipping',
    priceWithCurrency: {
      amount:       (Number.isFinite(amount) ? amount : 0).toFixed(2),
      currencyCode: STORE_CURRENCY,
    },
  };
}

// ─── §WEBHOOK::resolveLineVariantIds (v2.7.0) ─────────────────────────
const FALLBACK_VARIANT_QUERY = `
  query FallbackVariant($q: String!) {
    productVariants(first: 3, query: $q) {
      nodes {
        id
        sku
        product { id status }
        wpv: metafield(namespace: "custom", key: "wordpress_variation_id") { value }
      }
    }
  }
`;

/**
 * يحدد variant شوبيفاي لسطر GTIN بتاعه فاضي/مش رقمي — SKU + custom.wordpress_variation_id.
 * القبول (الأربعة مع بعض، وإلا بيرمي): ① item.sku موجود ② variant واحد بالظبط ③ node.sku === item.sku
 * حرفيًا (بحث شوبيفاي بيرجّع نتايج قريبة) ④ node.wpv.value === String(item.variation_id).
 * ⚠️ محتاج read_products — من غيرها ACCESS_DENIED (بيتفحص في diag).
 * مفيش تخمين: أي شرط ناقص = نفس الخطأ القديم + السبب.
 */
async function resolveVariantByFallback(env, token, item, idx) {
  const label = `Line item ${idx + 1} (${item.name || item.sku})`;
  const fail  = (why) => new Error(
    `${label} missing global_unique_id — product not synced to WooCommerce yet [fallback بالـ SKU فشل: ${why}]`
  );
  const sku = typeof item.sku === 'string' ? item.sku.trim() : '';
  if (!sku) throw fail('item.sku فاضي');
  if (item.variation_id === undefined || item.variation_id === null || item.variation_id === '' || String(item.variation_id) === '0') {
    throw fail('item.variation_id مش موجود (مش سطر variation)');
  }

  let res;
  try {
    res = await shopifyGQL(env, token, FALLBACK_VARIANT_QUERY,
      { q: `sku:"${sku.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` }, 'fallbackVariant');
  } catch (e) {
    throw fail(`استعلام شوبيفاي فشل — ${e.message}`);
  }
  const nodes = res.data?.productVariants?.nodes || [];
  if (nodes.length !== 1) throw fail(`لقينا ${nodes.length} variant للـ SKU (لازم واحد بالظبط)`);
  const node = nodes[0];
  if (node.sku !== sku) throw fail(`SKU الراجع مختلف ("${node.sku}")`);
  if (String(node.wpv?.value ?? '') !== String(item.variation_id)) {
    throw fail(`custom.wordpress_variation_id (${node.wpv?.value ?? 'فاضي'}) ≠ variation_id (${item.variation_id})`);
  }
  return node.id;
}

/**
 * بيرجّع مصفوفة variantId (GID) لكل سطر. المسار العادي (GTIN أرقام فقط) = صفر نداءات.
 * الـ fallback بيتسجّل تحذير في warnings.
 */
async function resolveLineVariantIds(env, token, body, warnings) {
  const ids = [];
  for (let idx = 0; idx < body.line_items.length; idx++) {
    const item = body.line_items[idx];
    const gtin = typeof item.global_unique_id === 'string' || typeof item.global_unique_id === 'number'
      ? String(item.global_unique_id).trim() : '';
    if (/^\d+$/.test(gtin)) { ids.push(`gid://shopify/ProductVariant/${gtin}`); continue; }
    const gid = await resolveVariantByFallback(env, token, item, idx);
    warnings.push(`global_unique_id فاضي لسطر ${idx + 1} (SKU ${item.sku}) — اتحدد الـ variant بالـ SKU + custom.wordpress_variation_id`);
    ids.push(gid);
  }
  return ids;
}

// ─── §WEBHOOK::buildDraftInput ────────────────────────────────────────
/**
 * Build DraftOrderInput from WooCommerce order body
 * variantIds: ناتج resolveLineVariantIds (نفس ترتيب line_items) — الـ GTIN/fallback اتحسموا قبل كده.
 *
 * §PRICING: كل line item بياخد priceOverride بسعر الوحدة الفعلي من WC
 * (item.total / item.quantity) — يضمن إن سعر المنتج في الأوردر على Shopify
 * يكون مطابق تمامًا لسعر WooCommerce وقت البيع، حتى لو كتالوج Shopify مختلف
 * (أعلى أو أقل). الـ override بيتطبق دايمًا — مش conditional.
 *
 * مصدر priceOverride field: Shopify GraphQL Admin API — DraftOrderLineItemInput
 * https://shopify.dev/docs/api/admin-graphql/latest/input-objects/draftorderlineiteminput
 */
function buildDraftInput(body, customerId, variantIds, warnings = []) {
  // Line items — requiresShipping: true مطلوبة صراحةً لكل line item
  const lineItems = body.line_items.map((item, idx) => ({
    variantId:        variantIds[idx],
    quantity:         item.quantity,
    requiresShipping: true,   // ← إلزامي — بدونه يظهر "Shipping not required"
    priceOverride: {
      amount:       getWCUnitPrice(item, idx),
      currencyCode: STORE_CURRENCY,
    },
  }));

  // Shipping address: استخدم shipping لو موجود، وإلا billing
  const wcShipping = body.shipping?.address_1?.trim()
    ? body.shipping
    : body.billing;

  // v2.7.0 — العناوين الطويلة: بتتقص على 255 والنص الكامل بيروح note
  const fullShip = [], fullBill = [];
  const shippingAddress = buildAddress(wcShipping,  { fallbackFirst: body.billing?.first_name, label: 'shipping', fullAddress: fullShip });
  const billingAddress  = buildAddress(body.billing, { fallbackFirst: body.billing?.first_name, label: 'billing',  fullAddress: fullBill });
  // لو الشحن = الفاتورة (نفس النص) منكرّرش النوت
  const longAddr = [...fullShip, ...fullBill.filter(b => !fullShip.some(x => x.full === b.full))];

  const input = {
    lineItems,
    shippingAddress,
    billingAddress,
    // v2.5.0 — سطر الشحن بيتبعت دايمًا (كان محذوف بالكامل قبل كده — راجع
    // الهيدر). من غيره Shopify بيقفل الأوردر بإجمالي ناقص قيمة الشحن.
    shippingLine:    buildShippingLine(body),
    // _worker_clone: يمنع Shopify Flow من عمل clone للـ draft ده
    tags: ['StyleBox', '_worker_clone'],
  };

  // ⚠️ `DraftOrderInput.customerId` مُهمَل في 2026-10 → purchasingEntity (اتأكد على المخطط 18-11-2026)
  if (customerId) input.purchasingEntity = { customerId };
  if (body.billing.email?.trim()) input.email = body.billing.email.trim();

  // ── الملاحظة ── ملاحظة العميل (v2.3.2) + العناوين الكاملة المقصوصة (v2.7.0)
  const noteParts = [];
  if (body.customer_note?.trim()) noteParts.push(decodeHtmlEntities(body.customer_note.trim()));
  for (const a of longAddr) {
    noteParts.push(`العنوان الكامل (اتقص لحد ${ADDRESS_MAX}) [${a.label}]: ${a.full}`);
    warnings.push(`${a.label} أطول من ${ADDRESS_MAX} حرف — اتقص والنص الكامل في note الأوردر`);
  }
  if (noteParts.length) input.note = noteParts.join('\n\n');

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
  // SELECT * عشان يشتغل قبل/بعد إضافة shopify_draft_id
  const existing = await db.prepare(
    `SELECT * FROM wc_order_sync_ledger WHERE wc_order_id = ?`
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
      // draftId: لو المحاولة السابقة وصلت لـ draftOrderCreate (العمود ممكن لسه مش موجود → undefined)
      return { claimed: true, retried: true, draftId: existing.shopify_draft_id || null };
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

// ─── §WEBHOOK::draft recovery (P2 — v2.7.0) ───────────────────────────
const DRAFT_STATUS_QUERY = `
  query DraftStatus($id: ID!) {
    draftOrder(id: $id) { id status order { id name displayFinancialStatus } }
  }
`;

// بيتكتب فورًا بعد draftOrderCreate. فشله ممنوع يوقّف الأوردر (حماية تكميلية):
// "no such column" = لسه الـ ALTER ما اتنفّذش → صامت. أي خطأ تاني → warning.
async function saveDraftId(db, wcOrderId, draftId, warnings) {
  try {
    await db.prepare(
      `UPDATE wc_order_sync_ledger SET shopify_draft_id = ? WHERE wc_order_id = ?`
    ).bind(draftId, wcOrderId).run();
  } catch (e) {
    if (!/no such column/i.test(String(e?.message))) {
      warnings.push(`shopify_draft_id ما اتكتبش في الـ ledger (${e.message}) — حماية الأوردر العالق مش فعّالة للأوردر ده`);
    }
  }
}

/**
 * المحاولة السابقة وصلت لـ draftOrderCreate — هل الـ draft اتكمّل أوردر فعلًا؟
 * بيرجّع {id, name} للأوردر لو اتكمّل، وإلا null (الـ draft مفتوح أو اتمسح → نكمّل عادي).
 * ⚠️ لو الاستعلام نفسه فشل بيرمي — الأحسن الأوردر يفشل ويتعاد من إنه يتكرر على شوبيفاي.
 */
async function findCompletedOrderForDraft(env, token, draftId) {
  const res = await shopifyGQL(env, token, DRAFT_STATUS_QUERY, { id: draftId }, 'draftStatus');
  const d = res.data?.draftOrder;
  return d?.order?.id ? d.order : null;
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

    // ── استرجاع أوردر عالق (P2): الـ draft اتكمّل قبل كده؟ ───────────────
    // لو الـ Worker وقع بعد draftOrderComplete وقبل markOrderCompleted، الأوردر موجود على شوبيفاي —
    // نكمّل الـ ledger بدل ما نعمل أوردر مكرر.
    const warnings = [];
    if (claim.draftId) {
      const done = await findCompletedOrderForDraft(env, token, claim.draftId);
      if (done) {
        const numericId = done.id.replace('gid://shopify/Order/', '');
        try { await setOrderMetafield(env, token, done.id, wcOrderId); }
        catch (e) { warnings.push(`الميتافيلد stylebox_order_id ما اتكتبش (${e.message}) — ضيفه يدويًا: WC #${wcOrderId}`); }
        await markOrderCompleted(env.DB, wcOrderId, numericId, done.name);
        await writeLog(env.DB, {
          tool: TOOL_NAME, type: 'skipped', orderId: numericId, orderName: done.name,
          notes: `WC #${wcOrderId} — اتعمل على شوبيفاي قبل كده (${done.name}) — الـ ledger اتصلّح من الـ draft من غير أوردر جديد`,
          extra: { wc_order_id: wcOrderId, recovered_from_draft: claim.draftId, shopify_order_id: done.id,
                   ...(warnings.length ? { warnings } : {}) },
        });
        return;
      }
    }

    // ── Customer lookup / create ─────────────────────────────────────
    // 🔴 ربط العميل **best-effort** — مش شرط لإنشاء الأوردر. (v2.6.1 — 19-11-2026)
    //    الأوردر هو الأساس؛ العميل تكميلي. لما `shopifyGQL` بقت بترمي على أخطاء GraphQL
    //    (v2.6.0)، غياب صلاحية `write_customers` على تطبيق شوبيفاي (ACCESS_DENIED على
    //    customerCreate) وقّف **كل** الأوردرات الجديدة بدل ما يكمّلها من غير عميل زي ما
    //    كان بيحصل. فشل اللوكب/الإنشاء بيتسجّل warning في extra.warnings والأوردر بيتكمّل
    //    (worker-builder Step 5A ⑩ ②: الفشل التكميلي = warning مش error).
    let customerId = null;
    try {
      customerId = await findOrCreateCustomer(env, token, body.billing);
    } catch (e) {
      warnings.push(`الأوردر اتعمل من غير ربط عميل على شوبيفاي (${e.message}) — لو الرسالة عن ACCESS_DENIED ادّي التطبيق صلاحية write_customers/read_customers`);
    }

    // ── تحديد variant كل سطر (GTIN، أو fallback بالـ SKU لو GTIN فاضي — v2.7.0) ──
    // ⚠️ ممكن يرمي error (variant مش متحقق منه) — هيتمسك في catch تحت ويتعمله
    // markOrderFailed (قابل لإعادة المحاولة)
    const variantIds = await resolveLineVariantIds(env, token, body, warnings);

    // ── Build draft order input (يشمل priceOverride لكل line item) ───
    const draftInput = buildDraftInput(body, customerId, variantIds, warnings);

    // ── draftOrderCreate ──────────────────────────────────────────────
    let draftResult = await shopifyGQL(
      env, token, DRAFT_ORDER_CREATE_MUTATION, { input: draftInput }
    );
    let draftErrors = draftResult.data?.draftOrderCreate?.userErrors;

    // v2.7.0 — إيميل بدومين غلط: لو **كل** userErrors على حقل email → إعادة محاولة **مرة واحدة** من غير
    // الإيميل (والأصلي في note). أي خطأ تاني يفشل زي ما هو — مش بنغطّي على أخطاء حقيقية.
    const onlyEmailErrors = (errs) => errs?.length > 0 && errs.every(e => Array.isArray(e.field) && e.field[0] === 'email');
    if (onlyEmailErrors(draftErrors) && draftInput.email) {
      const badEmail = draftInput.email;
      warnings.push(`الإيميل "${badEmail}" رفضته شوبيفاي (${draftErrors.map(e => e.message).join(' | ')}) — الأوردر اتعمل من غير إيميل والأصلي في note`);
      delete draftInput.email;
      draftInput.note = [draftInput.note, `إيميل العميل الأصلي (شوبيفاي رفضته): ${badEmail}`].filter(Boolean).join('\n\n');
      draftResult = await shopifyGQL(
        env, token, DRAFT_ORDER_CREATE_MUTATION, { input: draftInput }
      );
      draftErrors = draftResult.data?.draftOrderCreate?.userErrors;
    }
    if (draftErrors?.length) {
      throw new Error(`draftOrderCreate failed: ${JSON.stringify(draftErrors)}`);
    }
    const draftId = draftResult.data?.draftOrderCreate?.draftOrder?.id;
    if (!draftId) {
      throw new Error(`no draftId returned — raw: ${JSON.stringify(draftResult).slice(0, 400)}`);
    }

    // P2 — الـ draft id فورًا (قبل الـ complete) عشان أي reclaim بعد وقوع الـ Worker يقدر يتأكد
    await saveDraftId(env.DB, wcOrderId, draftId, warnings);

    // ── draftOrderComplete → real order with COD gateway ──────────────
    const completeResult = await shopifyGQL(
      env, token, DRAFT_ORDER_COMPLETE_MUTATION, {
        id:               draftId,
        paymentGatewayId: env.COD_GATEWAY_ID || COD_GATEWAY_GID,
        // ⚠️ `paymentPending` مُهمَل (Deprecated) في 2026-10 لكنه لسه شغّال ومثبّت في الـ docs.
        //    البديل (paymentTerms على الـ draft) بيغيّر سلوك الـ COD — قرار مؤجَّل، مسجّل
        //    في CLAUDE.md تحت «🔴 معلّقة». متشالش من غير اختبار حي على أوردر حقيقي.
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
    // 🔴 الأوردر اتكمّل على شوبيفاي خلاص — فشل الكتابة هنا مايرميش (الرمي = markOrderFailed
    //    = إعادة محاولة = أوردر مكرّر على شوبيفاي). بيتسجّل warning ويتكمّل (worker-builder ⑩ ②).
    try {
      await setOrderMetafield(env, token, order.id, wcOrderId);
    } catch (e) {
      warnings.push(`الأوردر اتعمل على شوبيفاي لكن ميتافيلد stylebox_order_id ما اتكتبش (${e.message}) — ضيفه يدويًا: WC #${wcOrderId}`);
    }

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
        // v2.5.0 — بيتسجّل عشان التحقق من الشحن يبقى ممكن من السجل نفسه:
        // عمود «الإجمالي» في الشاشة بيعرض wc_total، فلو الشحن ضاع تاني
        // على شوبيفاي مفيش أي طريقة تكشفه من الواجهة من غير الحقل ده.
        wc_shipping_total:  body.shipping_total ?? null,
        shopify_order_id:   order.id,
        shopify_order_name: order.name,
        financial_status:   order.displayFinancialStatus,
        customer_email:     body.billing.email || null,
        customer_phone:     normalizePhone(body.billing.phone),
        line_item_prices:   lineItemPrices,
        retried_after_failure: claim.retried,
        ...(warnings.length ? { warnings } : {}),
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
    if (typeof env.WORKER_SECRET !== 'string' || !env.WORKER_SECRET.trim()) {
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
          await env.DB.prepare('SELECT shopify_draft_id FROM wc_order_sync_ledger LIMIT 1').first();
          checks.push({ ok: true, label: 'ledger.shopify_draft_id', detail: 'العمود موجود — حماية الأوردر العالق فعّالة' });
        } catch (e) {
          checks.push({ ok: false, label: 'ledger.shopify_draft_id',
            detail: 'العمود مش موجود — الحماية من التكرار بعد وقوع الـ Worker مش فعّالة. نفّذ في D1 Console: ALTER TABLE wc_order_sync_ledger ADD COLUMN shopify_draft_id TEXT;' });
        }

        try {
          const row = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM employees WHERE is_active = 1'
          ).first();
          checks.push({ ok: true, label: 'جدول employees', detail: `${row?.n ?? 0} موظف نشط` });
        } catch (e) {
          checks.push({ ok: false, label: 'جدول employees', detail: `فشل الاستعلام: ${e.message}` });
        }

        // شوبيفاي — OAuth + الصلاحيات + تكلفة الاستعلام (قراءة فقط، صفر كتابة)
        try {
          const token = await getAccessToken(env);
          const d = await shopifyGQL(env, token,
            '{ currentAppInstallation { accessScopes { handle } } }', {}, 'diagScopes');
          const scopes = (d?.data?.currentAppInstallation?.accessScopes || []).map(x => x.handle);
          checks.push({ ok: true, label: 'Shopify OAuth', detail: 'التوكن اتجاب بنجاح' });
          // ℹ️→❌ write_customers: من غيرها الأوردر بيتعمل بس من غير ربط عميل (warning في السجل)
          checks.push({ ok: scopes.includes('write_customers'), label: 'write_customers',
            detail: scopes.includes('write_customers') ? 'ممنوحة' : 'ناقصة — الأوردرات بتتعمل من غير ربط عميل. ضيفها في Shopify app (Dev Dashboard → Versions → Access scopes) وبعدها Release' });
          // 🔴 read_products: الـ fallback بالـ SKU (v2.7.0) بيعتمد عليه لما global_unique_id يبقى فاضي.
          //    من غيرها استعلام productVariants بيرجّع ACCESS_DENIED والأوردر ده بيفشل زي ما كان قبل v2.7.0.
          checks.push({ ok: scopes.includes('read_products'), label: 'read_products',
            detail: scopes.includes('read_products') ? 'ممنوحة' : 'ناقصة — fallback الـ SKU (لما GTIN فاضي) مش هيشتغل. ضيفها في Shopify app (Dev Dashboard → Versions → Access scopes) وبعدها Release' });
          checks.push({
            ok: scopes.includes('write_draft_orders') && scopes.includes('write_orders'),
            label: 'accessScopes',
            detail: scopes.length ? scopes.join(', ') : '(فاضية — الأداة محتاجة write_draft_orders و write_orders)',
          });
          // ℹ️ read_all_orders: بدونها الأوردرات الأقدم من 60 يوم بترجع «غير موجود» بدل خطأ صلاحية —
          //    الأداة دي بتنشئ أوردرات بس مابتقراش قديم، فالفحص معلومة مش شرط (shopify-graphql-helper §3.2).
          checks.push({ ok: true, label: 'read_all_orders',
            detail: scopes.includes('read_all_orders') ? 'ممنوحة' : 'غير ممنوحة — مش مطلوبة للأداة دي (بتنشئ أوردرات ومابتقراش قديم)' });
          const t = d?.extensions?.cost?.throttleStatus;
          if (t) checks.push({ ok: true, label: 'throttleStatus',
            detail: `متاح ${t.currentlyAvailable} من ${t.maximumAvailable} · استرجاع ${t.restoreRate}/ث` });
          const qc = d?.extensions?.cost;
          if (qc) checks.push({ ok: true, label: 'actualQueryCost',
            detail: `آخر نداء كلّف ${qc.actualQueryCost ?? '؟'} نقطة (المطلوب ${qc.requestedQueryCost ?? '؟'})` });
        } catch (e) {
          checks.push({ ok: false, label: 'Shopify', detail: `فشل: ${e.message}` });
        }

        checks.push({
          ok:     true,
          label:  'CORS',
          detail: `wildcard * — الأداة قراءة فقط من الواجهة، والحماية في WORKER_SECRET. الطلب جاي من ${request.headers.get('Origin') || '(بدون Origin)'}`,
        });

        return json({ ok: checks.every(c => c.ok), version: WORKER_VERSION, tool: TOOL_NAME, envKeys, checks });
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
