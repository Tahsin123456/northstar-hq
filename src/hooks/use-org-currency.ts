"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * The organization's base currency, for a form that has to parse an amount.
 *
 * It decides how many decimal places an input accepts and which symbol is
 * stripped off a pasted figure, so a wrong guess misparses a typed amount — on
 * fields where a stray decimal place is a factor of a hundred.
 *
 * SHARED RATHER THAN COPIED. This started life inside the hit-rule dialog as
 * `useHitPaymentCurrency`, and the moment a second money field appeared on the
 * same page the copy would have been the version that quietly kept the fallback
 * after the real currency arrived. It reads the same query key the settings
 * page uses, so all three share one cached copy.
 */
export const ORGANIZATION_SETTINGS_KEY = ["settings", "organization"] as const;

/**
 * Only until the organization's own currency arrives.
 *
 * USD's two decimal places match every currency this app supports that has any,
 * which is why the fallback is safe rather than merely convenient — the one
 * currency it would be wrong for is JPY, and a form that opened on the fallback
 * remounts when the real code lands.
 */
export const FALLBACK_CURRENCY = "USD";

/**
 * `enabled` is the caller's permission check, not a preference. The settings
 * endpoint refuses a reader who may not have it, so a form gated on one
 * permission must not issue a request that 403s for everyone who opens it.
 */
export function useOrgBaseCurrency(enabled: boolean): string {
  const { data } = useQuery({
    queryKey: ORGANIZATION_SETTINGS_KEY,
    queryFn: api.getOrganizationSettings,
    enabled,
    staleTime: 5 * 60 * 1000,
  });
  return data?.organization.baseCurrency ?? FALLBACK_CURRENCY;
}
