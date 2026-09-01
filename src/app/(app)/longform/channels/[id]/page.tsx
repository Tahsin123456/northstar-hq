"use client";

import { use } from "react";
import { ChannelDetailBody } from "@/components/channel/channel-detail-body";

/**
 * Channel detail — the Long Form route.
 *
 * The same body as /channels/[id], mounted under the /longform layout's
 * `LongformFiltersProvider`: the format context reads "longform", so the body
 * fetches the Long Form dataset, counts long-form videos in every figure, and
 * speaks in the format's own words. See `ChannelDetailBody` for what is
 * deliberately Shorts-only.
 */
export default function LongformChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <ChannelDetailBody channelId={id} />;
}
