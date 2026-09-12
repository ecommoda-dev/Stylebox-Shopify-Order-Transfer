<div dir="rtl" style="text-align: right;">

# Stylebox-Shopify-Order-Transfer

![version](https://img.shields.io/badge/version-v1.0.0-blue)

نقل أوردرات **stylebox.online** (WooCommerce) إلى **Shopify** تلقائيًا، وشاشة عرض
لمتابعة النقل.

## القطعتين

| القطعة | الملف | الرابط |
|---|---|---|
| الـ Worker | `index.js` | `https://stylebox-shopify-order-transfer-worker.ecommoda-dev.workers.dev` |
| الواجهة | `index.html` | `https://ecommoda-dev.github.io/Stylebox-Shopify-Order-Transfer/` |

## إزاي بتشتغل

1. العميل بيعمل أوردر على stylebox.online، وبوابة الدفع عند الاستلام بتحوّل حالته
   لـ `processing`.
2. WooCommerce بيبعت ويبهوك (Topic: **Order updated**) للـ Worker.
3. الـ Worker بيتأكد من التوقيع (HMAC-SHA256)، وبيحجز الأوردر في جدول منفصل في D1
   عشان ما يتنقلش مرتين.
4. بينشئ Draft Order على شوبيفاي بنفس المنتجات والأسعار والعنوان وملاحظة العميل،
   وبيكمّله كأوردر COD حقيقي.
5. بيكتب رقم أوردر WooCommerce في ميتافيلد `custom.stylebox_order_id`، وبيسجّل
   النتيجة في D1.

## الشاشة

**عرض فقط — مفيش أي أكشن بيتنفّذ منها.**

- **نظرة عامة:** عدّادات الفترة مقارنة بالفترة السابقة · حالة سجل الحماية من التكرار ·
  جدول الأوردرات اللي فشلت أو عالقة.
- **سجل العمليات:** فلاتر متعددة الاختيار + بحث + فترة، ترتيب على الأعمدة، صفحات
  100 صف، وتصدير XLSX.

## النشر

الريبو هو المصدر الوحيد. أي push على الفرع الإنتاجي بينشر الـ Worker تلقائيًا
(Cloudflare Workers Builds)، والواجهة من GitHub Pages.

⛔ **ممنوع نسخ/لصق كود في داشبورد Cloudflare بعد الربط** — أول push جاي بيمسحه.

التفاصيل التشغيلية والفخاخ وقيم D1 → **`CLAUDE.md`**.

</div>

آخر تحديث: 12-09-2026 — 09:17
