"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Suggestions = {
  parts: { slug: string; title: string }[];
  categories: { slug: string; titleFa: string }[];
  brands: { slug: string | null; name: string }[];
  identifiers: { partSlug: string; value: string }[];
  vehicles: { slug: string; label: string }[];
};

const EMPTY: Suggestions = { parts: [], categories: [], brands: [], identifiers: [], vehicles: [] };
const RECENT_KEY = "poom_recent_searches";
const RECENT_MAX = 6;

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function SearchBox({ initialVehicleHint }: { initialVehicleHint?: string | null }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sug, setSug] = useState<Suggestions>(EMPTY);
  const [recent, setRecent] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRecent(loadRecent());
  }, []);

  // Debounced autocomplete — 250ms; aborts superseded requests.
  useEffect(() => {
    const norm = q.trim();
    if (norm.length < 2) {
      setSug(EMPTY);
      setFailed(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(norm)}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error("unavailable");
        setSug((await res.json()) as Suggestions);
        setFailed(false);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setFailed(true);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  // Close on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const persistRecent = (term: string) => {
    const next = [term, ...loadRecent().filter((x) => x !== term)].slice(0, RECENT_MAX);
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — recent list is best-effort */
    }
    setRecent(next);
  };

  const hasAny =
    sug.parts.length + sug.categories.length + sug.brands.length + sug.identifiers.length + sug.vehicles.length > 0;

  return (
    <div ref={boxRef} className="relative w-full">
      <form
        action="/search"
        className="flex gap-2"
        onSubmit={() => {
          const term = q.trim();
          if (term) persistRecent(term);
        }}
      >
        <input
          name="q"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          className="input flex-1"
          placeholder={initialVehicleHint ? `جستجو برای ${initialVehicleHint}…` : "جستجوی قطعه، برند یا کد فنی…"}
          aria-label="جستجوی قطعه"
          role="combobox"
          aria-expanded={open && (hasAny || recent.length > 0)}
          aria-controls="search-suggestions"
          autoComplete="off"
        />
        <button className="btn-primary">جستجو</button>
      </form>

      {open && (
        <div id="search-suggestions" role="listbox" className="absolute z-50 mt-1 w-full rounded-lg border border-black/10 bg-white p-2 shadow-lg">
          {failed && <p className="p-2 text-xs text-amber-700">جستجو موقتاً در دسترس نیست.</p>}

          {q.trim().length < 2 && recent.length > 0 && (
            <div className="p-1">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-[11px] text-black/40">جستجوهای اخیر</span>
                <button
                  type="button"
                  className="text-[11px] text-black/40 underline"
                  onClick={() => {
                    window.localStorage.removeItem(RECENT_KEY);
                    setRecent([]);
                  }}
                >
                  پاک کردن جستجوها
                </button>
              </div>
              {recent.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="block w-full rounded px-2 py-1.5 text-start text-sm hover:bg-black/5"
                  onClick={() => {
                    setQ(r);
                    persistRecent(r);
                    setOpen(false);
                    window.location.href = `/search?q=${encodeURIComponent(r)}`;
                  }}
                >
                  {r}
                </button>
              ))}
            </div>
          )}

          {q.trim().length >= 2 && hasAny && (
            <div className="space-y-1">
              {sug.parts.length > 0 && (
                <Group title="قطعات">
                  {sug.parts.map((p) => (
                    <Item key={p.slug} href={`/parts/${p.slug}`} onClick={() => persistRecent(q.trim())}>{p.title}</Item>
                  ))}
                </Group>
              )}
              {sug.categories.length > 0 && (
                <Group title="دسته‌بندی‌ها">
                  {sug.categories.map((c) => (
                    <Item key={c.slug} href={`/categories/${c.slug}`} onClick={() => persistRecent(q.trim())}>{c.titleFa}</Item>
                  ))}
                </Group>
              )}
              {sug.vehicles.length > 0 && (
                <Group title="خودرو">
                  {sug.vehicles.map((v) => (
                    <Item key={v.slug} href={`/search?vehicle=${v.slug}`} onClick={() => persistRecent(q.trim())}>{v.label}</Item>
                  ))}
                </Group>
              )}
              {sug.brands.length > 0 && (
                <Group title="برندها">
                  {sug.brands.map((b) => (
                    <Item key={b.name} href={`/search?q=${encodeURIComponent(b.name)}`} onClick={() => persistRecent(q.trim())}>{b.name}</Item>
                  ))}
                </Group>
              )}
              {sug.identifiers.length > 0 && (
                <Group title="شناسه‌های قطعه">
                  {sug.identifiers.map((i) => (
                    <Item key={`${i.partSlug}-${i.value}`} href={`/parts/${i.partSlug}`} onClick={() => persistRecent(q.trim())} ltr>{i.value}</Item>
                  ))}
                </Group>
              )}
            </div>
          )}

          {q.trim().length >= 2 && !hasAny && !failed && (
            <p className="p-2 text-xs text-black/40">پیشنهادی نیست — کلید Enter را بزنید تا جستجو شود.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-2 pb-0.5 pt-1 text-[11px] text-black/40">{title}</div>
      {children}
    </div>
  );
}

function Item({ href, children, onClick, ltr }: { href: string; children: React.ReactNode; onClick?: () => void; ltr?: boolean }) {
  return (
    <Link href={href} role="option" onClick={onClick} className="block rounded px-2 py-1.5 text-sm hover:bg-black/5" dir={ltr ? "ltr" : undefined}>
      {children}
    </Link>
  );
}
