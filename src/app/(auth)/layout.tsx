import { BRAND } from "@/lib/brand";

/**
 * The signed-out shell.
 *
 * Nothing here fetches data, mounts the dataset providers, or renders a single
 * navigation item — a person on this screen has not been authorised to see the
 * shape of the product yet, and every request the app shell would fire is
 * guaranteed to 401 anyway.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface-sunken px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex flex-col items-center gap-1.5 text-center">
          <div className="flex size-9 items-center justify-center rounded-lg bg-accent text-[15px] font-semibold text-accent-foreground">
            N
          </div>
          <h1 className="mt-2 text-[17px] font-semibold tracking-tight text-foreground">
            {BRAND.product}
          </h1>
          <p className="text-[12px] uppercase tracking-[0.14em] text-subtle-foreground">
            {BRAND.company}
          </p>
        </div>
        {children}
        <p className="mt-6 text-center text-[11px] leading-relaxed text-subtle-foreground">
          Internal system. Access is logged and limited to authorised {BRAND.company} staff.
        </p>
      </div>
    </main>
  );
}
