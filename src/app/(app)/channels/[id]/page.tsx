"use client";

import { use } from "react";
import { ChannelDetailBody } from "@/components/channel/channel-detail-body";

/**
 * Channel detail — the Shorts route.
 *
 * The whole page moved verbatim into `ChannelDetailBody` so the Long Form
 * segment can mount the identical body under its own provider. This route
 * sits under the app shell's Shorts `FiltersProvider`, whose format context
 * is "shorts", so every figure here is exactly what this page always showed.
 */
export default function ChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <ChannelDetailBody channelId={id} />;
}
