# P2-C — Vehicle Configuration 2.0

Date: 2026-09-14 · Status: implemented + verified (see PHASE2-C-FINAL-REPORT.md)

## What changed

### Engine / Transmission entities (schema `20260914_p2c_vehicle_config`)

P2-B stored engine/transmission as **free-text labels** on `Fitment` rules and
`VehicleVariant`. P2-C introduces first-class entities:

```prisma
model Engine        { id, vehicleId → Vehicle, name, code?, descriptionFa?, dataStatus, active, variants[]  @@unique([vehicleId, name]) }
model Transmission  { id, vehicleId → Vehicle, name, code?, dataStatus, active, variants[]                   @@unique([vehicleId, name]) }
enum BodyType       { HATCHBACK SEDAN WAGON SUV PICKUP OTHER }
model Vehicle       { …, bodyType BodyType?, engines[], transmissions[] }
model VehicleVariant{ …, engineId → Engine?, transmissionId → Transmission?, legacy engine/transmission text kept }
```

Design decisions:

- **Entities are per-vehicle** (`@@unique([vehicleId, name])`) — an engine name
  belongs to one vehicle's catalogue; no global engine registry was needed.
- **Legacy text columns kept** on `VehicleVariant` and `Fitment` because P2-B
  fitment rules match constraints by text (`rule.engine === ctx.engine`). The
  seed keeps `Engine.name` identical to the legacy label, so
  `ctx.engine = engineRef.name` satisfies old rules without a data migration.
- **No invented manufacturer codes.** Demo values are `TU5 (DEMO)`,
  `TU3 (DEMO)`, `دستی ۵ سرعته (DEMO)` — all `dataStatus: DEMO`.

### VehicleContext (one shape everywhere)

```ts
// src/lib/fitment.ts — the canonical type (re-exported by src/lib/vehicle.ts)
type VehicleContext = {
  vehicleId: string
  variantId?: string | null
  engineId?: string | null
  transmissionId?: string | null
  engine?: string | null        // constraint text the engine matches on
  transmission?: string | null
  bodyType?: string | null
  year?: number | null
}
```

`resolveVehicleContext(variantId, year?)` (src/lib/vehicle.ts) fills every field
the DB actually has and nothing more — missing data stays missing. Returns the
context plus display labels (`vehicleLabel`, `variantLabel`, …) for the UI.

### Consumers of the single context

| Surface | How it gets the context |
|---|---|
| Fitment Engine | `resolveFitment(partId, ctx)` — unchanged P2-B authority |
| Search | `searchParts2({ vehicleContext })` — retrieval hint + batched verdicts |
| Part page | active garage vehicle → URL `?variant&year` override → 3D cookie → none |
| Garage | persisted rows are (variantId, year) pairs; context resolved on read |
| 3D flow | unchanged (`vehicleId`, `variantId`); verdicts still via the engine |

## Demo data (seed.mjs)

- `Engine`: TU5 (DEMO) for تیپ ۵, TU3 (DEMO) for تیپ ۲ — `dataStatus: DEMO`.
- `Transmission`: دستی ۵ سرعته (DEMO) for both variants.
- `Vehicle.bodyType = HATCHBACK` — **labelled DEMO in the UI wherever shown**;
  the production fact is NOT VERIFIED.
- Variant legacy `engine`/`transmission` text kept byte-identical to entity
  names so P2-B fitment rules keep matching.

## Known limitations

- Body type is a vehicle-level enum; variant-level body differences not modeled.
- `year` remains a plain Gregorian integer (schema convention documented in
  P2-B rules doc); Jalali input in [1300–2100] is accepted but not converted.
- No admin UI yet for Engine/Transmission CRUD (inspectable via
  `/admin/vehicles`); planned for P2-D if catalog growth requires it.
