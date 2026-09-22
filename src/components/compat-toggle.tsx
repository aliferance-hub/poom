"use client";

/**
 * Compatibility filter toggle (P2-C). The search page is a Server Component,
 * so the change handler lives here: ticking submits the hidden #compat-form,
 * which carries q/cat/sort/vehicle as hidden inputs and lands on ?compat=1.
 */
export function CompatToggle({ defaultChecked, label }: { defaultChecked: boolean; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        form="compat-form"
        name="compat"
        value="1"
        defaultChecked={defaultChecked}
        onChange={(e) => (document.getElementById("compat-form") as HTMLFormElement | null)?.requestSubmit()}
      />
      {label}
    </label>
  );
}
