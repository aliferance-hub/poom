import { mockPayAction } from "@/app/actions";

export default async function MockPayPage({ searchParams }: { searchParams: Promise<{ authority?: string }> }) {
  const { authority } = await searchParams;

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="card space-y-4 p-6 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-blue-50 text-2xl">💳</div>
        <h1 className="text-lg font-bold">درگاه پرداخت نمایشی (Mock)</h1>
        <p className="text-xs leading-5 text-black/50">
          این صفحه جایگزین درگاه واقعی (مثل زرین‌پال) است. هیچ پول واقعی جابه‌جا نمی‌شود.
          پس از انتخاب نتیجه، موجودی فقط در صورت موفقیت کاهش می‌یابد.
        </p>
        <div className="rounded-lg bg-black/4 p-2 text-xs text-black/60" dir="ltr">{authority ?? "NO_AUTHORITY"}</div>
        {!authority ? (
          <p className="text-sm text-red-600">authority نامعتبر است.</p>
        ) : (
          <div className="flex justify-center gap-2">
            <form action={mockPayAction}>
              <input type="hidden" name="authority" value={authority} />
              <input type="hidden" name="outcome" value="success" />
              <button className="btn-primary">پرداخت موفق</button>
            </form>
            <form action={mockPayAction}>
              <input type="hidden" name="authority" value={authority} />
              <input type="hidden" name="outcome" value="failure" />
              <button className="btn-ghost !text-red-600">شبیه‌سازی خطا</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
