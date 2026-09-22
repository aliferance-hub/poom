// POOM seed — ALL DATA IS DEMO. No real OEM codes, prices, sellers or warranties.
// Idempotent: safe to re-run (upserts / find-then-create everywhere).
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const ZONES = [
  { key: 'engine',     title: 'موتور',            desc: 'بلوک، سرسیلندر و متعلقات موتور' },
  { key: 'cooling',    title: 'سیستم خنک‌کاری',    desc: 'رادیاتور، فن و قطعات خنک‌کاری' },
  { key: 'brakes',     title: 'ترمز',             desc: 'لنت، دیسک و کاسه ترمز' },
  { key: 'suspension', title: 'جلوبندی و تعلیق',  desc: 'کمک، توپی و قطعات جلوبندی' },
  { key: 'wheels',     title: 'چرخ‌ها',            desc: 'لاستیک و رینگ' },
  { key: 'body',       title: 'بدنه',             desc: 'سپر، آینه، گلگیر و قطعات بدنه' },
  { key: 'electrical', title: 'برق و الکترونیک',  desc: 'دینام، استارت و سنسورها' },
  { key: 'interior',   title: 'داخل کابین',       desc: 'آیینه، دسته‌درب و قطعات کابین' },
];

const CAM = {
  engine:     { position: [3.2, 2.4, 4.2], target: [0, 0.9, 1.6] },
  cooling:    { position: [2.6, 1.8, 3.4], target: [0, 0.9, 1.7] },
  brakes:     { position: [2.8, 1.2, 2.6], target: [0.9, 0.4, 1.6] },
  suspension: { position: [2.4, 1.4, 3.0], target: [0.9, 0.4, 1.6] },
  wheels:     { position: [3.0, 1.2, 3.6], target: [1.0, 0.4, 0.9] },
  body:       { position: [0.5, 2.2, 5.2], target: [0, 0.8, 0] },
  electrical: { position: [2.2, 2.0, 3.2], target: [0, 0.9, 1.5] },
  interior:   { position: [0.2, 1.8, 1.8], target: [0, 1.0, 0.2] },
};

// ── Category tree (P2-B) — demo taxonomy, nullable per part ──
// slug: [titleFa, parentSlug]
const CATEGORIES = {
  'engine-cat':      ['موتور', null],
  'cooling-cat':     ['خنک‌کاری', 'engine-cat'],
  'radiator-cat':    ['رادیاتور', 'cooling-cat'],
  'fan-thermo-cat':  ['فن و ترموستات', 'cooling-cat'],
  'hose-cap-cat':    ['شلنگ و درپوش', 'cooling-cat'],
  'fuel-cat':        ['سوخت‌رسانی', 'engine-cat'],
  'air-cat':         ['هوا و فیلترها', 'engine-cat'],
  'oil-cat':         ['روغن‌کاری', 'engine-cat'],
  'ignition-cat':    ['برق و جرقه موتور', 'engine-cat'],
  'brakes-cat':      ['ترمز', null],
  'brake-pad-cat':   ['لنت و کفشک', 'brakes-cat'],
  'brake-disc-cat':  ['دیسک و سیلندر', 'brakes-cat'],
  'brake-misc-cat':  ['متعلقات ترمز', 'brakes-cat'],
  'suspension-cat':  ['جلوبندی و تعلیق', null],
  'shock-cat':       ['کمک‌فنر', 'suspension-cat'],
  'arm-cat':         ['طبق و سیبک', 'suspension-cat'],
  'bearing-cat':     ['بلبرینگ', 'suspension-cat'],
  'wheels-cat':      ['چرخ و لاستیک', null],
  'body-cat':        ['بدنه', null],
  'light-cat':       ['چراغ', 'body-cat'],
  'mirror-cat':      ['آینه', 'body-cat'],
  'bumper-cat':      ['سپر و گریل', 'body-cat'],
  'body-misc-cat':   ['متعلقات بدنه', 'body-cat'],
  'electrical-cat':  ['برق و الکترونیک', null],
  'interior-cat':    ['داخل کابین', null],
};

const BRANDS = [
  { slug: 'demo-brand-a', name: 'برند نمونه الف (DEMO)' },
  { slug: 'demo-brand-b', name: 'برند نمونه ب (DEMO)' },
  { slug: 'demo-brand-c', name: 'برند نمونه ج (DEMO)' },
];

// [zone, assemblyTitle, [ [skuSuffix, titleFa, slug, offers, categorySlug, brandIdx, specsJson] ] ]
const CATALOG = [
  ['engine', 'موتور و متعلقات', [
    ['OIL-FLT', 'فیلتر روغن', 'oil-filter-206', [[890000, 12, 1, 0], [950000, 5, 2, 1], [840000, 2, 3, 2]], 'oil-cat', 0, { type: 'روغن‌گیری (نمونه)' }],
    ['AIR-FLT', 'فیلتر هوا', 'air-filter-206', [[1240000, 8, 1, 0], [1310000, 6, 2, 1]], 'air-cat', 1, null],
    ['CABIN-FLT', 'فیلتر کابین', 'cabin-filter-206', [[980000, 10, 2, 1], [1050000, 3, 1, 0], [1120000, 7, 2, 2]], 'air-cat', 2, null],
    ['FUEL-FLT', 'فیلتر بنزین', 'fuel-filter-206', [[1480000, 4, 2, 0], [1550000, 0, 3, 1]], 'fuel-cat', 0, null],
    ['SPARK-PLG', 'شمع موتور (ست ۴)', 'spark-plug-set-206', [[2180000, 9, 1, 0], [2290000, 5, 2, 2], [2450000, 2, 1, 1]], 'ignition-cat', 1, null],
    ['BELT-TMG', 'تسمه تایم', 'timing-belt-206', [[3350000, 6, 2, 1], [3520000, 1, 2, 0]], 'engine-cat', 2, null],
    ['OIL-PMP', 'پمپ روغن', 'oil-pump-206', [[8900000, 2, 3, 0], [9400000, 1, 4, 2]], 'oil-cat', 0, null],
    ['WATER-VALVE', 'شیر آب موتور', 'water-valve-206', [[1690000, 3, 2, 1], [1780000, 2, 2, 0]], 'cooling-cat', 1, null],
    ['NOFIT', 'پمپ بنزین بدون اطلاعات سازگاری (نمونه)', 'no-fitment-demo-206', [[4250000, 2, 3, 0]], 'fuel-cat', 2, null],
  ]],
  ['cooling', 'سیستم خنک‌کاری', [
    ['RADIATOR', 'رادیاتور آب', 'radiator-206', [[6800000, 5, 2, 0], [7200000, 3, 1, 1], [6400000, 1, 3, 2], [7900000, 0, 2, 1]], 'radiator-cat', 0, { material: 'آلومینیوم (نمونه)', position: 'جلو' }],
    ['FAN-MTR', 'موتور فن رادیاتور', 'radiator-fan-motor-206', [[3450000, 4, 2, 1], [3600000, 2, 1, 0]], 'fan-thermo-cat', 1, null],
    ['THRMOSTAT', 'ترموستات', 'thermostat-206', [[1250000, 7, 1, 0], [1190000, 4, 2, 2]], 'fan-thermo-cat', 2, null],
    ['RAD-CAP', 'درپوش رادیاتور', 'radiator-cap-206', [[420000, 15, 1, 0], [390000, 9, 2, 1], [450000, 6, 1, 2]], 'hose-cap-cat', 0, null],
    ['EXP-TANK', 'منبع انبساط', 'expansion-tank-206', [[2150000, 3, 2, 1], [2280000, 2, 2, 0]], 'hose-cap-cat', 1, null],
    ['COOL-HOSE', 'شلنگ بالادست رادیاتور', 'radiator-hose-upper-206', [[1320000, 6, 2, 0], [1410000, 1, 3, 2]], 'hose-cap-cat', 2, null],
  ]],
  ['brakes', 'سیستم ترمز', [
    ['PAD-FRT', 'لنت ترمز جلو', 'brake-pad-front-206', [[3980000, 8, 1, 0], [3650000, 4, 2, 1], [4200000, 6, 1, 2]], 'brake-pad-cat', 0, { position: 'جلو' }],
    ['PAD-REAR', 'لنت ترمز عقب', 'brake-pad-rear-206', [[2980000, 5, 1, 0], [3150000, 2, 2, 1]], 'brake-pad-cat', 1, { position: 'عقب' }],
    ['DISC-FRT', 'دیسک ترمز جلو (جفت)', 'brake-disc-front-206', [[6850000, 3, 2, 1], [7300000, 2, 2, 0]], 'brake-disc-cat', 2, null],
    ['BRAKE-SHOE', 'کفشک ترمز دستی', 'brake-shoe-206', [[1780000, 7, 2, 2], [1850000, 3, 1, 0]], 'brake-pad-cat', 0, null],
    ['WHL-CYL', 'سیلندر چرخ عقب', 'wheel-cylinder-206', [[1980000, 4, 2, 0], [2100000, 1, 3, 1]], 'brake-disc-cat', 1, null],
    ['BRAKE-HOSE', 'شلنگ ترمز جلو', 'brake-hose-front-206', [[890000, 9, 1, 1], [940000, 5, 2, 0]], 'brake-misc-cat', 2, null],
  ]],
  ['suspension', 'جلوبندی و تعلیق', [
    ['STRUT-FRT', 'کمک جلو (جفت)', 'shock-absorber-front-206', [[11800000, 2, 3, 0], [12500000, 1, 3, 1]], 'shock-cat', 0, null],
    ['BALL-JNT', 'توپی بوش طبق', 'ball-joint-206', [[1450000, 6, 2, 1], [1520000, 2, 2, 2]], 'arm-cat', 1, null],
    ['CNTRL-ARM', 'طبق چرخ جلو', 'control-arm-206', [[4650000, 3, 3, 0], [4880000, 2, 2, 2]], 'arm-cat', 2, null],
    ['STAB-LINK', 'میله واسط جلوبندی', 'stabilizer-link-206', [[980000, 10, 1, 1], [1050000, 4, 2, 0]], 'arm-cat', 0, null],
    ['CV-BOOT', 'کاسه نمد شفت گاردان', 'cv-boot-206', [[680000, 8, 2, 0], [720000, 3, 1, 2]], 'arm-cat', 1, null],
    ['PART-002', 'بوش طبق مخصوص تیپ ۲ (نمونه)', 'demo-part-002', [[1560000, 4, 2, 1]], 'arm-cat', 1, { position: 'جلو (نمونه)' }],
  ]],
  ['wheels', 'چرخ و لاستیک', [
    ['TIRE-185', 'لاستیک ۱۸۵/۵۵R15', 'tire-185-55r15', [[5900000, 12, 1, 0], [5650000, 8, 2, 1], [6400000, 4, 1, 2]], 'wheels-cat', 2, { size: '185/55R15 (نمونه)' }],
    ['WHL-BRG', 'بلبرینگ چرخ جلو', 'wheel-bearing-front-206', [[2350000, 5, 2, 1], [2480000, 2, 2, 0]], 'bearing-cat', 0, null],
    ['HUB-CAP', 'کاپ چرخ', 'hub-cap-206', [[380000, 20, 1, 2], [350000, 11, 2, 0]], 'wheels-cat', 1, null],
  ]],
  ['body', 'بدنه و خارجی', [
    ['MIRROR-LH', 'آینه بغل راست (برقی)', 'side-mirror-206', [[3450000, 2, 3, 0], [3680000, 1, 3, 1]], 'mirror-cat', 2, null],
    ['BMPR-GRLL', 'گریل سپر جلو', 'front-grille-206', [[2890000, 3, 2, 1], [3050000, 2, 2, 0]], 'bumper-cat', 0, null],
    ['HDR-LT', 'چراغ جلو راست', 'headlight-right-206', [[7650000, 2, 2, 0], [8100000, 1, 3, 2]], 'light-cat', 1, null],
    ['WIP-BLADE', 'تیغه برف‌پاک‌کن (جفت)', 'wiper-blade-set-206', [[1150000, 14, 1, 1], [980000, 9, 2, 0], [1250000, 5, 1, 2]], 'body-misc-cat', 2, null],
    ['DOOR-HNDL', 'دسته‌درب بیرونی چپ', 'outer-door-handle-206', [[890000, 6, 2, 0], [940000, 2, 2, 1]], 'body-misc-cat', 0, null],
  ]],
  ['electrical', 'برق و الکترونیک', [
    ['ALTRNTR', 'دینام', 'alternator-206', [[14500000, 2, 3, 0], [15300000, 1, 4, 1]], 'electrical-cat', 1, null],
    ['STRTR', 'استارت', 'starter-motor-206', [[12800000, 2, 3, 2], [13400000, 1, 3, 0]], 'electrical-cat', 2, null],
    ['BATT-55', 'باطری ۵۵ آمپر', 'battery-55ah', [[4950000, 7, 1, 0], [5200000, 4, 1, 1], [4750000, 3, 2, 2]], 'electrical-cat', 0, { capacity: '55Ah (نمونه)', voltage: '12V (نمونه)' }],
    ['O2-SENS', 'سنسور اکسیژن', 'oxygen-sensor-206', [[3250000, 3, 2, 1], [3480000, 2, 2, 0]], 'electrical-cat', 1, null],
    ['IGN-COIL', 'کویل دابل', 'ignition-coil-206', [[2890000, 5, 2, 0], [3050000, 3, 1, 2]], 'electrical-cat', 2, null],
  ]],
  ['interior', 'داخل کابین', [
    ['CABIN-MRR', 'آیینه سالن', 'interior-mirror-206', [[520000, 8, 1, 1], [480000, 5, 2, 0]], 'interior-cat', 0, null],
    ['FLR-MAT', 'کفپوش سه‌تکه', 'floor-mat-set-206', [[1890000, 10, 2, 0], [1750000, 6, 2, 2]], 'interior-cat', 1, null],
    ['GEAR-KNOB', 'دنده‌گیر', 'gear-knob-206', [[640000, 9, 1, 1], [690000, 4, 2, 0]], 'interior-cat', 2, null],
  ]],
];

await prisma.$transaction(async (tx) => {
  // ── Demo sellers (explicitly unverified demo entities) ──
  const sellers = [];
  const sellerNames = ['فروشنده نمایشی ۱', 'فروشنده نمایشی ۲', 'فروشنده نمایشی ۳'];
  for (let i = 0; i < 3; i++) {
    sellers.push(await tx.seller.upsert({
      where: { id: `demo-seller-${i + 1}` },
      update: {},
      create: {
        id: `demo-seller-${i + 1}`,
        businessName: sellerNames[i],
        city: 'تهران (DEMO)',
        status: 'DEMO_UNVERIFIED',
        rating: [4.8, 4.6, 4.9][i],
        responseRate: [0.92, 0.87, 0.95][i],
        verified: false,
      },
    }));
  }

  // ── Category tree + brands ──
  const catBySlug = {};
  for (const [slug, [titleFa, parentSlug]] of Object.entries(CATEGORIES)) {
    catBySlug[slug] = await tx.category.upsert({
      where: { slug },
      update: { titleFa, parentId: parentSlug ? catBySlug[parentSlug]?.id ?? null : null },
      create: { slug, titleFa, parentId: parentSlug ? catBySlug[parentSlug]?.id ?? null : null, sortOrder: Object.keys(catBySlug).length },
    });
  }
  const brandBySlug = {};
  for (const b of BRANDS) {
    brandBySlug[b.slug] = await tx.brand.upsert({ where: { slug: b.slug }, update: { name: b.name }, create: b });
  }
  const brandList = Object.values(brandBySlug);

  // ── Vehicle + variants ──
  const vehicle = await tx.vehicle.upsert({
    where: { make_model: { make: 'Peugeot', model: '206' } },
    update: { bodyType: 'HATCHBACK' },
    create: { make: 'Peugeot', model: '206', displayName: 'پژو ۲۰۶', bodyType: 'HATCHBACK', generation: 'NF', active: true },
  });

  // ── Engine / Transmission entities (P2-C, synthetic DEMO codes) ──
  const engineTU3 = await tx.engine.upsert({
    where: { vehicleId_name: { vehicleId: vehicle.id, name: 'TU3 (DEMO)' } },
    update: { code: 'DEMO-ENGINE-001' },
    create: { vehicleId: vehicle.id, name: 'TU3 (DEMO)', code: 'DEMO-ENGINE-001', descriptionFa: 'موتور بنزینی — داده نمایشی', dataStatus: 'DEMO' },
  });
  const engineTU5 = await tx.engine.upsert({
    where: { vehicleId_name: { vehicleId: vehicle.id, name: 'TU5 (DEMO)' } },
    update: { code: 'DEMO-ENGINE-002' },
    create: { vehicleId: vehicle.id, name: 'TU5 (DEMO)', code: 'DEMO-ENGINE-002', descriptionFa: 'موتور بنزینی — داده نمایشی', dataStatus: 'DEMO' },
  });
  const transMan = await tx.transmission.upsert({
    where: { vehicleId_name: { vehicleId: vehicle.id, name: 'دستی ۵ سرعته' } },
    update: { code: 'DEMO-TRANS-001' },
    create: { vehicleId: vehicle.id, name: 'دستی ۵ سرعته', code: 'DEMO-TRANS-001', dataStatus: 'DEMO' },
  });

  const variantT2 = await tx.vehicleVariant.upsert({
    where: { vehicleId_trim: { vehicleId: vehicle.id, trim: 'تیپ ۲' } },
    update: { engineId: engineTU3.id, transmissionId: transMan.id },
    create: {
      vehicleId: vehicle.id, trim: 'تیپ ۲', engine: 'TU3 (DEMO)', transmission: 'دستی ۵ سرعته',
      engineId: engineTU3.id, transmissionId: transMan.id,
      productionStart: 2002, productionEnd: 2012, notes: 'داده نمایشی — نیازمند تأیید کارشناس',
    },
  });
  const variantT5 = await tx.vehicleVariant.upsert({
    where: { vehicleId_trim: { vehicleId: vehicle.id, trim: 'تیپ ۵' } },
    update: { engineId: engineTU5.id, transmissionId: transMan.id },
    create: {
      vehicleId: vehicle.id, trim: 'تیپ ۵', engine: 'TU5 (DEMO)', transmission: 'دستی ۵ سرعته',
      engineId: engineTU5.id, transmissionId: transMan.id,
      productionStart: 2003, productionEnd: 2015, notes: 'داده نمایشی — نیازمند تأیید کارشناس',
    },
  });

  // ── Zones + assemblies ──
  const zoneByKey = {};
  for (const [i, z] of ZONES.entries()) {
    zoneByKey[z.key] = await tx.vehicleZone.upsert({
      where: { vehicleId_key: { vehicleId: vehicle.id, key: z.key } },
      update: { title: z.title, description: z.desc, sortOrder: i },
      create: { vehicleId: vehicle.id, key: z.key, title: z.title, description: z.desc, sortOrder: i },
    });
  }

  /** Idempotent fitment by full dimension tuple (mirrors Fitment_dimensions_guard). */
  async function ensureFitment(data) {
    const where = {
      partId_vehicleId: { partId: data.partId, vehicleId: data.vehicleId },
    };
    const existing = await tx.fitment.findFirst({
      where: {
        partId: data.partId, vehicleId: data.vehicleId,
        variantId: data.variantId ?? null, engine: data.engine ?? null,
        transmission: data.transmission ?? null, bodyType: data.bodyType ?? null,
        yearFrom: data.yearFrom ?? null, yearTo: data.yearTo ?? null,
      },
    });
    if (existing) {
      await tx.fitment.update({ where: { id: existing.id }, data: { fitmentStatus: data.fitmentStatus, fitmentNote: data.fitmentNote } });
      return existing;
    }
    return tx.fitment.create({ data });
  }

  // ── Parts + identifiers + base fitments + offers ──
  let partCount = 0;
  const partsBySlug = {};
  for (const [zoneKey, assemblyTitle, items] of CATALOG) {
    const zone = zoneByKey[zoneKey];
    const assembly = await tx.assembly.upsert({
      where: { slug: `assembly-${zoneKey}` },
      update: { title: assemblyTitle, zoneId: zone.id },
      create: { zoneId: zone.id, title: assemblyTitle, slug: `assembly-${zoneKey}` },
    });

    for (const [suffix, titleFa, slug, offers, catSlug, brandIdx, specs] of items) {
      const sku = `DEMO-206-${suffix}-001`;
      const part = await tx.part.upsert({
        where: { sku },
        update: {
          title: titleFa,
          categoryId: catSlug ? catBySlug[catSlug]?.id ?? null : null,
          brandId: brandList[brandIdx % brandList.length]?.id ?? null,
          specificationsJson: specs ?? undefined,
          dataStatus: 'DEMO',
        },
        create: {
          sku, title: titleFa, slug, assemblyId: assembly.id,
          technicalDescription: 'قطعه نمایشی برای MVP — مشخصات فنی واقعی نیست.',
          dataStatus: 'DEMO',
          categoryId: catSlug ? catBySlug[catSlug]?.id ?? null : null,
          brandId: brandList[brandIdx % brandList.length]?.id ?? null,
          specificationsJson: specs ?? undefined,
          identifiers: { create: [
            { type: 'MPN', value: `DEMO-MPN-${suffix}-001` },
            { type: 'CROSS_REFERENCE', value: `DEMO-XREF-${suffix}-001` },
          ]},
        },
      });
      partsBySlug[slug] = part;
      partCount++;

      // Base fitments: both trims, generic ranges (Gregorian, same as variant rows).
      // Matrix-case parts (below) define their OWN rules and skip the generic rows:
      //   NOFIT (case J: no data) · WATER-VALVE (case F) · SPARK-PLG (case C) · PART-002 (case B)
      const matrixPart = ['NOFIT', 'WATER-VALVE', 'SPARK-PLG', 'PART-002'].includes(suffix);
      if (!matrixPart) {
        await ensureFitment({ partId: part.id, vehicleId: vehicle.id, variantId: variantT2.id, yearFrom: 2002, yearTo: 2012, fitmentStatus: 'CONFIRMED', fitmentNote: 'DEMO — تأیید نشده' });
        await ensureFitment({ partId: part.id, vehicleId: vehicle.id, variantId: variantT5.id, yearFrom: 2003, yearTo: 2015, fitmentStatus: 'CONFIRMED', fitmentNote: 'DEMO — تأیید نشده' });
      }

      let n = 1;
      for (const [price, stock, shipDays, sellerIdx] of offers) {
        const seller = sellers[sellerIdx];
        const existingOffer = await tx.offer.findFirst({ where: { sellerId: seller.id, partId: part.id } });
        if (existingOffer) {
          await tx.offer.update({ where: { id: existingOffer.id }, data: { price, active: true } }); // stock untouched on re-seed
        } else {
          await tx.offer.create({ data: {
            sellerId: seller.id, partId: part.id, price, stock, shippingDays: shipDays,
            sellerSku: `DEMO-SKU-S${sellerIdx + 1}-${suffix}-${String(n).padStart(2, '0')}`,
            warrantyNote: 'DEMO — بدون ضمانت واقعی', condition: 'NEW', active: true, lowStockThreshold: 3,
          }});
        }
        n++;
      }
    }
  }

  // ── Fitment matrix (P2-B test cases) ──
  // Deterministic reset: matrix parts define EXACTLY the rules below (removes rows
  // left by older seeds or test debris so re-running the seed is reproducible).
  const matrixSlugs = ['no-fitment-demo-206', 'water-valve-206', 'spark-plug-set-206', 'demo-part-002'];
  await tx.fitment.deleteMany({
    where: { part: { slug: { in: matrixSlugs } } },
  });
  // Case F: vehicle-level COMPATIBLE + variant-level REJECTED → INCOMPATIBLE for تیپ ۵
  await ensureFitment({ partId: partsBySlug['water-valve-206'].id, vehicleId: vehicle.id, variantId: null, yearFrom: 2002, yearTo: 2015, fitmentStatus: 'CONFIRMED', fitmentNote: 'DEMO — قالب کلی ۲۰۶' });
  await ensureFitment({ partId: partsBySlug['water-valve-206'].id, vehicleId: vehicle.id, variantId: variantT5.id, fitmentStatus: 'REJECTED', fitmentNote: 'برای تیپ ۵ جاگذاری متفاوت است (نمونه)' });
  await ensureFitment({ partId: partsBySlug['water-valve-206'].id, vehicleId: vehicle.id, variantId: variantT2.id, fitmentStatus: 'CONFIRMED', fitmentNote: 'برای تیپ ۲ سازگار (نمونه)' });

  // Case D/E: year-range specific rule on the radiator (دهه پایانی منفی)
  await ensureFitment({ partId: partsBySlug['radiator-206'].id, vehicleId: vehicle.id, variantId: variantT5.id, yearFrom: 2013, yearTo: 2015, fitmentStatus: 'REJECTED', fitmentNote: 'در سال‌های پایانی تغییرات رادیاتور اعمال شده (نمونه)' });

  // Case C: review-required on spark plugs (both trims PARTIAL)
  await ensureFitment({ partId: partsBySlug['spark-plug-set-206'].id, vehicleId: vehicle.id, variantId: variantT5.id, fitmentStatus: 'PARTIAL', fitmentNote: 'نیازمند بررسی: کد دقیق شمع برای موتور TU5 مشخص نشده است' });
  await ensureFitment({ partId: partsBySlug['spark-plug-set-206'].id, vehicleId: vehicle.id, variantId: variantT2.id, fitmentStatus: 'PARTIAL', fitmentNote: 'نیازمند بررسی: کد دقیق شمع برای موتور TU3 مشخص نشده است' });

  // Case G: engine-specific on timing belt (TU5 سازگار / TU3 ناسازگار)
  await ensureFitment({ partId: partsBySlug['timing-belt-206'].id, vehicleId: vehicle.id, variantId: variantT5.id, engine: 'TU5 (DEMO)', fitmentStatus: 'CONFIRMED', fitmentNote: 'مخصوص موتور TU5 (نمونه)' });
  await ensureFitment({ partId: partsBySlug['timing-belt-206'].id, vehicleId: vehicle.id, variantId: variantT5.id, engine: 'TU3 (DEMO)', fitmentStatus: 'REJECTED', fitmentNote: 'تسمه تایم TU3 با TU5 تفاوت دارد (نمونه)' });

  // Case H: transmission-specific on battery
  await ensureFitment({ partId: partsBySlug['battery-55ah'].id, vehicleId: vehicle.id, variantId: variantT5.id, transmission: 'اتوماتیک (DEMO)', fitmentStatus: 'REJECTED', fitmentNote: 'برای گیربکس اتوماتیک جای نصب متفاوت است (نمونه)' });

  // Case I: open-ended year range on the tire
  await ensureFitment({ partId: partsBySlug['tire-185-55r15'].id, vehicleId: vehicle.id, variantId: variantT5.id, yearFrom: 2010, yearTo: null, fitmentStatus: 'CONFIRMED', fitmentNote: 'از سال ۲۰۱۰ به بعد — سمت پایانی باز (نمونه)' });

  // Case B: تیپ ۲-only part (negative on تیپ ۵)
  await ensureFitment({ partId: partsBySlug['demo-part-002'].id, vehicleId: vehicle.id, variantId: variantT2.id, fitmentStatus: 'CONFIRMED', fitmentNote: 'مخصوص تیپ ۲ (نمونه)' });
  await ensureFitment({ partId: partsBySlug['demo-part-002'].id, vehicleId: vehicle.id, variantId: variantT5.id, fitmentStatus: 'REJECTED', fitmentNote: 'فقط برای تیپ ۲ — با تیپ ۵ سازگار نیست (نمونه)' });

  // Case J part (no-fitment-demo-206) intentionally gets NO fitment rows.

  // ── Related parts (REQUIRES / OFTEN_PURCHASED_WITH / RELATED — no fake REPLACEMENT) ──
  async function ensureRelated(partSlug, relatedSlug, type, noteFa) {
    const a = partsBySlug[partSlug], b = partsBySlug[relatedSlug];
    if (!a || !b || a.id === b.id) return;
    await tx.relatedPart.upsert({
      where: { partId_relatedPartId_type: { partId: a.id, relatedPartId: b.id, type } },
      update: { noteFa },
      create: { partId: a.id, relatedPartId: b.id, type, noteFa },
    });
  }
  await ensureRelated('radiator-206', 'radiator-cap-206', 'REQUIRES', 'هنگام تعویض رادیاتور، درپوش نیز بررسی شود (نمونه)');
  await ensureRelated('brake-pad-front-206', 'brake-disc-front-206', 'OFTEN_PURCHASED_WITH', 'معمولاً همراه با دیسک تعویض می‌شود (نمونه)');
  await ensureRelated('radiator-206', 'radiator-hose-upper-206', 'RELATED', 'شلنگ بالادست همان مدار خنک‌کاری (نمونه)');
  await ensureRelated('oil-filter-206', 'air-filter-206', 'OFTEN_PURCHASED_WITH', 'سرویس دوره‌ای همزمان (نمونه)');

  // ── 3D Asset Contract (current P2-A schema) ──
  const asset = await tx.asset.upsert({
    where: { assetId: 'peugeot-206-main-v1' },
    update: {},
    create: { assetId: 'peugeot-206-main-v1', vehicleId: vehicle.id, format: 'builtin', source: 'DEMO_PRIMITIVES' },
  });
  const version = await tx.assetVersion.upsert({
    where: { assetId_version: { assetId: asset.id, version: 1 } },
    update: { status: 'ACTIVE' },
    create: {
      assetId: asset.id, version: 1, status: 'ACTIVE', filePath: 'builtin:placeholder-206',
      licenseType: 'IN_REPO_DEMO', commercialUse: true, creator: 'POOM (demo)', activatedAt: new Date(),
    },
  });
  await tx.assetVersion.updateMany({ where: { assetId: asset.id, id: { not: version.id }, status: 'ACTIVE' }, data: { status: 'ARCHIVED' } });

  for (const [key, cam] of Object.entries(CAM)) {
    await tx.meshMapping.upsert({
      where: { versionId_meshName: { versionId: version.id, meshName: `zone_${key}` } },
      update: { kind: 'zone', zoneId: zoneByKey[key].id, cameraPositionJson: cam.position, cameraTargetJson: cam.target },
      create: { versionId: version.id, meshName: `zone_${key}`, kind: 'zone', zoneId: zoneByKey[key].id, cameraPositionJson: cam.position, cameraTargetJson: cam.target },
    });
  }
  const partMappings = [
    ['part_radiator_main', 'radiator-206'],
    ['part_brake_pad_front_main', 'brake-pad-front-206'],
    ['part_oil_filter_main', 'oil-filter-206'],
    ['part_battery_main', 'battery-55ah'],
    ['part_floor_mat_main', 'floor-mat-set-206'],
  ];
  for (const [meshName, slug] of partMappings) {
    const part = partsBySlug[slug];
    if (!part) continue;
    await tx.meshMapping.upsert({
      where: { versionId_meshName: { versionId: version.id, meshName } },
      update: { kind: 'part', partId: part.id },
      create: { versionId: version.id, meshName, kind: 'part', partId: part.id },
    });
  }

  console.log(`✔ seed: vehicle=${vehicle.displayName} parts=${partCount} sellers=3 zones=${ZONES.length} categories=${Object.keys(CATEGORIES).length} brands=${BRANDS.length}`);
});
