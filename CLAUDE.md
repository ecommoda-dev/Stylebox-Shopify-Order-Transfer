<div dir="rtl" style="text-align: right;">

# نقل أوردرات StyleBox (`Stylebox-Shopify-Order-Transfer`)

![version](https://img.shields.io/badge/version-v1.1.1-blue)

**بتعمل إيه:** بتستقبل ويبهوك من WooCommerce (stylebox.online) وبتنشئ نفس الأوردر
على Shopify تلقائيًا كأوردر COD، وبتعرض حالة النقل في شاشة عرض.
**مين بيستخدمها:** إدارة · متابعة الأوردرات (الشاشة عرض فقط، مفيش أي أكشن).
**الإصدار:** Worker `v2.8.0` · الواجهة `v1.1.0`   ← الاتنين مستقلين، طبيعي يختلفوا

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/Stylebox-Shopify-Order-Transfer/
الـ Worker : https://stylebox-shopify-order-transfer-worker.ecommoda-dev.workers.dev
اسم الـ Worker في الداشبورد: stylebox-shopify-order-transfer-worker
الويبهوك   : POST على رابط الـ Worker من غير أي action (Topic: Order updated)
```

## الـ Endpoints

| `?action=` | بيعمل إيه |
|---|---|
| (مفيش — POST) | استقبال ويبهوك WooCommerce. **بره بوابة `WORKER_SECRET`** لأن WooCommerce مابيبعتش `Authorization` — الحماية بتوقيع HMAC (`WC_WEBHOOK_SECRET`). أي إعادة ترتيب للراوت ده = كل تسليمة 401 |
| `get_summary` | عدّادات الفترة + الفترة السابقة + حالة الـ ledger + آخر حدث |
| `get_attention` | أوردرات `failed` أو `in_progress` عالقة + آخر رسالة خطأ لكل واحد |
| `get_logs` · `get_logs_count` · `get_logs_export` | السجل — فلترة وترتيب وصفحات server-side، والتصدير بيرجّع `cap`/`total`/`truncated` |
| `get_employees` · `check_employee` · `register_pin` · `verify_employee` · `log_logout` | شاشة الدخول |
| `get_config` · `diag` · `status` | نسخة الـ Worker والفحص الذاتي |

## D1

```
tool  : wc_order_transfer
type  : created · skipped · error · login · logout
```

> 🔴 **`login` و`logout` جديدين على الأداة دي** (اتضافوا مع واجهة v1.0.0).
> لازم يتسجّلوا في `ecommoda-constants` §7 — الصف الحالي هناك فيه
> `created · skipped · error` بس. **بند مفتوح لحد ما يتعمل.**

**جدول إضافي في نفس القاعدة** (غير `logs`/`employees` المشتركين):

```sql
wc_order_sync_ledger (wc_order_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'in_progress',
                      shopify_order_id TEXT, shopify_order_name TEXT,
                      claimed_at TEXT NOT NULL, completed_at TEXT)
```

الجدول ده هو الحماية الحقيقية من تكرار الأوردر على شوبيفاي — `INSERT OR IGNORE`
عملية واحدة atomic، فمفيش نافذة سباق بين الفحص والكتابة.
الحالات: `in_progress` (محجوز دلوقتي) · `completed` (خلص) · `failed` (قابل لإعادة المحاولة).

## المضبوط فعليًا في الداشبورد

> اللي **متظبط بالفعل** — مش اللي المفروض يكون.

```
Bindings : DB → ecommoda-dev-logs
Secrets  : WORKER_SECRET · WC_WEBHOOK_SECRET · CLIENT_ID · CLIENT_SECRET
Vars     : SHOP_DOMAIN · COD_GATEWAY_ID     ← دلوقتي مصدرهم [vars] في wrangler.toml
Build watch paths : * (الافتراضي) — التضييق لسه ما اتعملش، راجع «مسائل مفتوحة»
```

### تصنيف الـ `env.*` — الصف التالت هو الخطر

| النوع | المتغيّرات | إزاي تتأكد |
|---|---|---|
| **Secret** | `WORKER_SECRET` · `WC_WEBHOOK_SECRET` · `CLIENT_ID` · `CLIENT_SECRET` | قيمتها مستحيلة القراءة من أي مكان. `?action=diag` بيعرض **الوجود والطول** بس |
| **Var بيرمي لو غاب** | `SHOP_DOMAIN` | غيابه بيخلي رابط شوبيفاي `undefined` والنداء بيفشل ويتسجّل `error` |
| 🔴 **Var ليه fallback** | `COD_GATEWAY_ID` | `env.COD_GATEWAY_ID \|\| COD_GATEWAY_GID` — **غيابه مابيوقّفش حاجة**، الأداة بتكمّل وبتكتب `created` عادي. اتكتب في `wrangler.toml` بنفس قيمة الداشبورد عشان الريبو يبقى المصدر |

## CORS

`wildcard *` — لأن الأداة **قراءة فقط من الواجهة**، وكل الـ endpoints (غير الويبهوك)
محمية بـ `WORKER_SECRET`. ده الخيار A في `ecommoda-worker-builder`
(`references/cors-patterns.md`) لأدوات القراءة.

## خط الأساس بعد النقل

> جرد D1 يوم 12-09-2026 قبل أول نشر من Git — مرجع لأي شك بعد كده.

```
logs   (tool = wc_order_transfer) : created 796 · skipped 866 · error 4
                                    أول صف 27-07-2026 · آخر created 11-09-2026 22:04 UTC
ledger (wc_order_sync_ledger)     : completed 796 · failed 2 · in_progress 2
```

⚠️ **الـ 2 `in_progress`** مؤرّخين 27-07-2026 — يعني **عالقين من زمان** (التنفيذ
اتقطع قبل ما يخلص)، وبيظهروا في «محتاج انتباه» على الشاشة. مش باج جديد.

**استعلام التحقق** (سطر واحد للـ D1 Console):

```sql
SELECT type, COUNT(*) AS n, MAX(timestamp) AS last_ts FROM logs WHERE tool = 'wc_order_transfer' GROUP BY type ORDER BY n DESC;
```

## فخاخ الأداة دي

- **`skipped` مش فشل.** WooCommerce بيبعت `order.updated` لأي تعديل، فالويبهوك
  بيتكرر لنفس الأوردر وهو لسه `processing`. التكرار بيترفض بالـ ledger — ده السلوك
  الصح. أي تقرير بيعدّ `skipped` كفشل بيدّي نسبة فشل وهمية (866 مقابل 4 أخطاء حقيقية).
- **الفلتر على `order.updated` + `processing`، مش `order.created`.** وقت
  `order.created` الأوردر لسه `pending` — بوابة COD بتحط `processing` في save منفصل.
- **`ctx.waitUntil` بيدّي 30 ثانية بس.** لو التنفيذ اتقطع، الصف بيفضل `in_progress`
  للأبد — عشان كده فيه reclaim بعد 3 دقايق (`STALE_IN_PROGRESS_MS`).
- **WooCommerce بيرجّع حقول العنوان بترميز HTML** (`&amp;` بدل `&`)، وشوبيفاي
  بيرفضها برسالة "Address can't contain HTML" — `decodeHtmlEntities()` بتتعمل على كل
  حقل نص قبل ما يتبعت. **الأوردرات اللي اتعملت قبل الإصلاح مش بتتصلح تلقائيًا.**
- 🔴 **الشحن كان بيضيع بالكامل لحد `v2.5.0`.** `buildDraftInput()` كانت بتبعت
  الـ draft من غير `shippingLine` خالص، وShopify **مابيحسبش** شحن لوحده للـ draft
  order — فكل أوردر كان بيتقفل بـ `shippingLines = []` وإجمالي ناقص قيمة الشحن.
  الباج كان كامن من أول يوم وما ظهرش غير لما WooCommerce فعّلت الـ Flat rate يوم
  **10-09-2026** — قبلها الـ 794 أوردر كلهم شحنهم صفر من WooCommerce نفسها.
  **3 أوردرات اتنقلت ناقصة** ومش بتتصلح تلقائيًا (تحت «مسائل مفتوحة»).
- **سطر الشحن بيتبعت دايمًا** من `v2.5.0` — حتى لو بصفر (بيظهر
  "Free shipping — 0.00"). قرار Ahmed 12-09-2026.
- **Shopify بياخد سطر شحن واحد بس** (`shippingLine` مفرد مش list). المبلغ بيتاخد
  من `shipping_total` (WooCommerce بيجمع فيه كل سطور الشحن فالفلوس بتفضل مضبوطة)،
  والعنوان من أول سطر بس — يعني لو فيه أكتر من سطر شحن، **الفلوس صح والاسم ناقص**.
- 🔴 **`shipping_total` مستثنى منه ضريبة الشحن** (`shipping_tax` حقل منفصل في
  WooCommerce، والكود مابيقراهوش). **المتجر من غير ضرايب وده قرار ثابت — مش هتتفعّل
  أبدًا** (Ahmed، 12-09-2026). البند مكتوب هنا عشان لو القرار ده اتغيّر في أي يوم،
  الشحن هيتنقل ناقص الضريبة **من غير أي رسالة خطأ**.
- **`priceOverride` بيتطبّق دايمًا** على كل line item بسعر الوحدة من WooCommerce —
  عشان السعر يطابق البيع حتى لو كتالوج شوبيفاي مختلف.
- **مفيش عمود «الموظف» في السجل** — كل الصفوف بتتكتب من الويبهوك من غير موظف.
- **فلتر التاريخ بيقارن `substr(timestamp,1,10)` يعني UTC**، والعرض بتوقيت القاهرة.
  عملية بعد 9 مساءً بتوقيت القاهرة ممكن تقع في يوم UTC اللي بعده. مقبول لفلتر
  بالأيام — بس مكتوب.

## استرجاع النسخ القديمة

> ده بديل الـ tags — دفع الـ tags ممنوع من جلسات Claude Code السحابية.

الأداة **ما كانش ليها أي HTML قبل كده** (Worker بس)، فمفيش ملفات نسخ مرقّمة للمسح.
كود الـ Worker زي ما كان منشور من الداشبورد محفوظ في أول commit:

```
git show a69fc43:index.js
```

⚠️ الملف ده **منقول نصًا** من `workers_get_worker_code` يوم 12-09-2026 — مش
مقارَن ببصمة md5 من المصدر، فاعتبره «النسخة المستوردة» مش إثبات رياضي.
اللي **متأكَّد منه بالـ diff**: كوميت `v2.4.0` ما لمسش ولا سطر في `§WEBHOOK`
ولا `§SHOPIFY` — يعني منطق النقل نفسه زي ما هو.

## 🛡️ Worker v2.7.0 (19-11-2026) — fallback لـ `global_unique_id` الفاضي + تنضيف مدخلات

**الخلفية:** 22 من 28 أوردر فاشل كانوا `missing global_unique_id` (مقاسات Skechers 46/47/48 منتج 14103 GTIN بتاعها فاضي في ووردبريس).

| التغيير | السلوك |
|---|---|
| **P0 fallback بالـ SKU** (`resolveLineVariantIds`) | لو GTIN فاضي/مش رقمي: استعلام `productVariants(query: sku:"…")` ويتقبل **بس** لو: SKU موجود · variant واحد بالظبط · `node.sku === item.sku` حرفيًا · `custom.wordpress_variation_id === String(item.variation_id)`. غير كده يفشل بنفس رسالة الخطأ القديمة + `[fallback بالـ SKU فشل: السبب]`. النجاح = تحذير في `extra.warnings` (من غير `type` جديد). GTIN رقمي = **صفر نداءات زيادة**. |
| **P1-١ اسم** | `cleanName` بيشيل `\p{Sm}`؛ الأول الفاضي → اسم الفاتورة → `"-"` |
| **P1-٢ عنوان > 255** | `address1`/`address2` بيتقصوا على حدود كلمة والنص الكامل في `input.note` + تحذير |
| **P1-٣ إيميل غلط** | لو `userErrors` كلها على `email` → إعادة محاولة **واحدة** من غير إيميل، والأصلي في note + تحذير |

✅ صلاحية **`read_products`** ممنوحة (19-11-2026). `?action=diag` فيه صف `read_products` — من غيرها الـ fallback بيرجّع ACCESS_DENIED.
✅ اتجرّب استعلام الـ fallback حيًا على Shopify MCP (`WA-SK-145 / Black / 46` → variant `55962731413826` · `wordpress_variation_id=14104` · المنتج `DRAFT`). ⚠️ **لسه ما اتجرّبش** إن `draftOrderCreate` يقبل variant تابع لمنتج DRAFT — الاختبار الحي بأوردر تجريبي (أحمد).
### 🛡️ v2.8.0 — P2: حماية الأوردر العالق من التكرار (`shopify_draft_id`)
**الخطر:** الـ Worker يقع بعد `draftOrderComplete` وقبل `markOrderCompleted` (حصل في `23795` → `#57067`) → أول ويبهوك `processing` بعد 3 دقايق كان هيعمل أوردر **مكرر**.
**الحل:** الـ draft id بيتكتب في `wc_order_sync_ledger.shopify_draft_id` فورًا بعد `draftOrderCreate`. وعند reclaim (`failed` أو `in_progress` stale) لصف عنده draft id: `draftOrder(id){ order }` — لو اتكمّل ← `markOrderCompleted` + إعادة كتابة الميتافيلد + صف `skipped` فيه `extra.recovered_from_draft`، **من غير أوردر جديد**. لو الـ draft مفتوح/اتمسح ← الإنشاء العادي. لو استعلام الـ draft نفسه فشل ← الأوردر `failed` (أأمن من التكرار).
**الـ ALTER (أحمد — D1 Console، سطر واحد):** `ALTER TABLE wc_order_sync_ledger ADD COLUMN shopify_draft_id TEXT;` — الكود شغّال قبله وبعده (`SELECT *` + "no such column" صامت)، و`?action=diag` فيه صف `ledger.shopify_draft_id` بيقول لو لسه ناقص.
⚠️ الحماية مش بتغطّي الأوردرات اللي وقعت **قبل** الـ ALTER (مفيش draft id متسجّل ليها).
⛔ **ممنوع إعادة تشغيل الأوردرات الفاشلة جماعيًا** — بعضها اتعمل يدوي على شوبيفاي (قرار لكل أوردر).

## 🔴 إصلاح انحدار — Worker v2.6.1 (19-11-2026)

**العطل:** بعد نشر v2.6.0 الأوردرات الجديدة وقفت (`#25958` · `#25959` · `#25960` → `status=failed` في `wc_order_sync_ledger`) برسالة
`Access denied for customerCreate field. Required access: write_customers access scope [ACCESS_DENIED]`.

**السبب:** تطبيق شوبيفاي **معندوش صلاحية `write_customers`**. `shopifyGQL` القديمة (`return resp.json()`) كانت بتبلع الرفض، فالعميل بيطلع `null`
والأوردر بيتعمل من غير عميل. v2.6.0 بدّلتها بالنسخة المعتمدة اللي **بترمي** — فبقى فشل إنشاء العميل بيوقف الأوردر كله. اختبار v2.6.0 ما مسكش ده
لأن شوبيفاي المزيّف كان بيرد بنجاح على `customerCreate`.

**الإصلاح:** ربط العميل بقى **best-effort** — فشل اللوكب أو الإنشاء بيتسجّل `warning` في `extra.warnings` والأوردر بيتكمّل (Step 5A ⑩ ②).
و🩺 فحص النظام بقى فيه صف `write_customers` (❌ لو ناقصة).

**اللي لسه محتاج منك:** ادّي التطبيق صلاحية `write_customers` (وراجع `read_customers`) في Shopify Dev Dashboard ← Versions ← Access scopes ← Release.
لحد وقتها الأوردرات هتتعمل **بدون ربط عميل** (زي ما كان الوضع قبل v2.6.0 بالظبط).

**الأوردرات اللي فشلت:** `#25958` · `#25959` · `#25960` — كل واحد منهم بيتعاد تلقائيًا أول ما ووكومرس يبعت `order.updated` تاني (احفظ الأوردر من wp-admin بدون تغيير).

## مواءمة 18-11-2026 — Worker v2.6.0 · الواجهة v1.1.0

> مواءمة مع المهارات الحالية. الاختبار: تدفق الويبهوك كامل اتشغّل على الكود الفعلي بـ D1 وشوبيفاي مزيّفين (12 حالة — 18-11-2026).

| الحاجة | قبل | بعد |
|---|---|---|
| إصدار API | `2026-01` | **`2026-10`** — كل وثيقة GraphQL اتفحصت على Shopify MCP |
| `shopifyGQL` | `return resp.json()` وبس (عطل موثّق في المهارة) | **النسخة المعتمدة**: بترمي على فشل الشبكة · HTTP · رد مش JSON · `data.errors` · `data` فاضية + إعادة محاولة على `THROTTLED`/429/5xx + التقاط التكلفة |
| `DraftOrderInput.customerId` | بيتبعت | **مُهمَل في 2026-10** → `purchasingEntity: { customerId }` |
| ميتافيلد `stylebox_order_id` | بتتكتب من غير أي تأكيد | **متأكَّد منها**، وفشلها بعد اكتمال الأوردر = **warning** في `extra.warnings` — الرمي كان هيخلّيها `failed` فيتعاد الأوردر ويتكرر على شوبيفاي (⑩ ②) |
| `getAccessToken` | محاولة واحدة | 3 محاولات + backoff |
| حارس `WORKER_SECRET` | `!env.WORKER_SECRET` | `typeof`+`trim` (سر فاضي بمسافة كان بيعدّي) |
| `diag` | فحوص D1 والمتغيّرات | + Shopify OAuth + الصلاحيات + `throttleStatus` + `actualQueryCost` + `read_all_orders` |
| الواجهة | خروج يدوي بـ`confirm` | خروج تلقائي 60 د + خروج فوري · لون النص الثانوي أغمق |

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v4.2.0 |
| ecommoda-html-builder | v9.1.1 |
| ecommoda-constants | v6.0.1 |
| shopify-graphql-helper | v3.2.0 |
| woocommerce-sync-helper | v2.1.1 |

آخر مطابقة: 19-11-2026 · `index.js` v2.8.0 · `index.html` v1.1.0
🔴 معلّقة:
- ✅ **اتقفل 19-11-2026:** `read_products` ممنوحة (اتأكدت من `?action=diag`) و`ALTER TABLE … shopify_draft_id` اتنفّذ (اتأكد بـ `pragma_table_info`). 🔴 **لسه:** اختبار حي بأوردر تجريبي (variant من منتج DRAFT).
- 🟡 **`paymentPending: true` في `draftOrderComplete` مُهمَل (Deprecated) في API `2026-10`** — لسه شغّال ومثبّت في docs شوبيفاي (اتأكد 18-11-2026)، فمفيش كسر دلوقتي. البديل (`paymentTerms` على الـ draft) بيغيّر سلوك الـ COD، فمتشالش من غير اختبار حي على أوردر حقيقي (Draft + Complete). لو شوبيفاي شالته في إصدار جاي، الأوردرات هتفشل بـ`failed` (قابلة لإعادة المحاولة) مش بتتكرر.
- 🟡 **شاشة السجل لسه على الشكل القديم (قسم فلاتر فوق الجدول — `S47`) ومن غير تحكم في عرض الأعمدة (`S51`)** — معيار الجداول الجديد (فلاتر في رأس العمود + قايمة `position:fixed` + مقبض سحب العرض، `data-table-standard.md` §2 و§9ب) إعادة تصميم كبيرة لشاشة تشغيل حيّة. اتأجّلت **بقرار مقصود** 18-11-2026 (المهارة نفسها بتصنّفها 🟡 «عند أول فتح، مش في حملة») عشان ما تتغيّرش من غير مراجعة بصرية حقيقية. تتعمل في جلسة مخصصة بـ `templates/24_data-table-section.html` + اختبار Playwright.
- 🟡 **Build watch paths** (chip لـ`index.js` وchip منفصل لـ`wrangler.toml`) — إعداد في داشبورد Cloudflare مش في الريبو، ماتأكدش منه من الجلسة دي.
- ⚠️ **اختبار حي لازم بعد النشر:** اعمل أوردر ووكومرس تجريبي (status=processing) وتأكد: الأوردر اتعمل على شوبيفاي · العميل اتربط (`purchasingEntity` بدل `customerId` المُهمَل) · الشحن · ميتافيلد `stylebox_order_id` — ولو الميتافيلد فشلت هتلاقي `extra.warnings` في صف `created` مش `error`.

> ℹ️ **24-09-2026 — الطبقة ٥ (Step 7-ج):** `check-log-values.mjs` اتستبدل
> بالنسخة المصلَّحة (كاشف مايعتمدش على أسماء الدوال + object shorthand
> صريح)، و`§LOG-REG` (`LOG_REGISTRY` + `noteUnregisteredLogValues`) اتحط
> في `writeLog`. خمس القيم الموجودة (`login`/`logout`/`created`/`error`/
> `skipped`) كانت **مسجّلة بالفعل** في `log-values.json` — مفيش قيمة جديدة
> اتضافت، البند ده مراقبة وقت التشغيل بس.

## مسائل مفتوحة

- 🔴 **3 أوردرات اتنقلت من غير مصاريف شحن** قبل إصلاح `v2.5.0` — محتاجة تعديل
  يدوي من Shopify Admin (الأوردر editable لأنه معمول بـ `draftOrderComplete`):

  | WC | Shopify | الشحن الناقص |
  |---|---|---|
  | #22514 | #54220 | 75 ج |
  | #23454 | #54396 | 100 ج |
  | #23516 | #54425 | 75 ج |

  الأوردرات الـ 794 اللي قبلهم **مش متأثرة** — WooCommerce نفسها كانت شحنها صفر.
- 🔴 **تسجيل `login` و`logout` في `ecommoda-constants` §7** تحت `wc_order_transfer`
  — الكود بيكتبهم من v2.4.0، والتسجيل لسه ما اتعملش.
- 🟡 **Build watch paths لسه `*`** — التضييق على `index.js` + `wrangler.toml` محتاج
  الاختبارين (HTML مابناش · `index.js` بنى ونشر)، وواحد منهم مش كفاية. لو اتعمل
  التضييق، **أي ملف جديد بيعتمد عليه الـ Worker لازم يتضاف للقايمة** وإلا هيفضل
  على نسخة قديمة من غير أي رسالة.
- 🟡 **رينيم `wc_sync` → `wc_order_transfer` لسه غير موثّق رسميًا**
  (`ecommoda-constants` §11 بند 6). D1 فيه صفوف بالاسمين: `wc_sync` (408 created)
  قديمة و`wc_order_transfer` الحالية.
- 🟡 **`ecommoda-tool-migration-playbook` نفسها مالهاش رقم إصدار**، فمابتدخلش جدول
  البصمة فوق رغم إنها المهارة اللي حكمت النقل ده.

آخر تحديث: 19-11-2026 — v2.8.0: حماية الأوردر العالق (shopify_draft_id) فوق fallback الـ SKU وتنضيف المدخلات

</div>
