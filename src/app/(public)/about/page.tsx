import type { Metadata } from "next";

import {
  Bullets,
  DocumentTitle,
  ExternalLink,
  InternalLink,
  Paragraph,
  Section,
} from "@/components/public/document";
import { BRAND } from "@/lib/brand";
import { PUBLIC_SITE } from "@/lib/public-site";

/**
 * The application home page, in Google's sense of the term.
 *
 * This is the URL that goes in the "Application home page" field on the OAuth
 * Branding form, and Google's automated brand verification fetches it and
 * parses the HTML. Three things follow from that, and all three are the reason
 * this page is shaped the way it is:
 *
 *   1. The product name must appear verbatim, because a documented failure is
 *      "App name does not match homepage". It is rendered from BRAND.product,
 *      which is the same constant the sidebar and the browser title use, so
 *      the name on this page cannot drift from the name in the app.
 *   2. The page must explain what the app does and why it asks for YouTube
 *      data, because the matching failure is "Homepage does not explain the
 *      purpose of your app".
 *   3. All of it must be in server-rendered HTML. A fetcher that does not
 *      execute JavaScript has to see the name and the description in the
 *      response body, so this is a plain server component with no client
 *      boundary anywhere in it.
 *
 * It also carries a visible link to the privacy policy, which Google requires
 * on the homepage in addition to the Branding field.
 */
export const metadata: Metadata = {
  // `absolute` bypasses the root layout's "%s · Northstar HQ" template so the
  // <title> is the product name exactly, with nothing appended for a name-match
  // check to trip over.
  title: { absolute: BRAND.product },
  description: `${BRAND.product} is an internal tool used by ${BRAND.company} to track how the studio's own YouTube Shorts perform. Access is limited to studio staff.`,
  robots: { index: true, follow: true },
};

export default function AboutPage() {
  return (
    <article>
      <DocumentTitle
        title={BRAND.product}
        intro={
          <>
            {BRAND.product} is the internal tool {BRAND.company} uses to see how its own
            YouTube Shorts are performing. It is not a public product, there is no sign-up,
            and access is limited to studio staff.
          </>
        }
      />

      <Section title="What it is">
        <Paragraph>
          {BRAND.company} publishes short-form video on YouTube. {BRAND.product} is the
          private dashboard the studio uses to answer everyday questions about that work:
          which Shorts took off and which did not, how a channel is trending week to week,
          how the studio&apos;s output compares against the wider market in the same niche,
          and what the channels earned. Before it existed, those answers were spread across
          YouTube Studio tabs and spreadsheets.
        </Paragraph>
        <Paragraph>
          It is a single-tenant, internal business tool. Nobody outside {BRAND.company} has
          an account, and there is no consumer-facing feature, no public API and no
          marketplace listing. This page exists because Google — correctly — requires an
          app requesting YouTube data to publish a plain description of itself and a
          privacy policy that anybody can read without logging in.
        </Paragraph>
      </Section>

      <Section title="What staff use it for">
        <Bullets>
          <li>
            Tracking view, like and comment counts on the studio&apos;s Shorts over time, so
            a video that is accelerating can be spotted while it is still accelerating.
          </li>
          <li>
            Measuring the hit rate of a channel or an editor against a view threshold the
            studio sets itself.
          </li>
          <li>
            Comparing the studio&apos;s channels against public competitor channels in the
            same niche, using data anyone can retrieve from the public YouTube API.
          </li>
          <li>
            Reading the studio&apos;s own YouTube revenue day by day, so payroll and
            performance can be reconciled against what the channels actually earned.
          </li>
          <li>
            Internal bookkeeping that has nothing to do with Google: notes, saved research,
            expenses and staff payroll.
          </li>
        </Bullets>
      </Section>

      <Section title="Why it connects to a Google account">
        <Paragraph>
          Some of what the studio needs to see about its own channels — most obviously
          revenue, and analytics that are not public — is only available to the account
          that owns the channel. So an administrator at {BRAND.company} connects the
          studio&apos;s own Google account and grants {BRAND.product} read-only access to
          the studio&apos;s YouTube data.
        </Paragraph>
        <Paragraph>
          That connection is not a login. Staff sign in to {BRAND.product} with an email
          address and a password issued by an administrator; connecting Google is a
          separate, admin-only action whose only purpose is to authorise reading the
          studio&apos;s own channel data. Every scope requested is read-only —{" "}
          {BRAND.product} cannot upload, edit, delete or comment on anything, and it does
          not ask for permission to.
        </Paragraph>
        <Paragraph>
          Exactly which data is read, why, where it is kept and how to revoke access is set
          out in full in the{" "}
          <InternalLink href={PUBLIC_SITE.paths.privacy}>privacy policy</InternalLink>
          .
        </Paragraph>
      </Section>

      <Section title="Who can use it">
        <Paragraph>
          Only people employed by or contracted to {BRAND.company}. Accounts are created by
          invitation from an administrator — there is no self-service registration — and
          what each person can see is limited further by their role and by the niches
          assigned to them. If you have reached this page without an account, there is
          nothing here to sign up for.
        </Paragraph>
      </Section>

      <Section title="Contact">
        <Paragraph>
          {BRAND.company} operates {BRAND.product}. For anything about this application,
          including questions about data and privacy, write to{" "}
          <ExternalLink href={`mailto:${PUBLIC_SITE.contactEmail}`}>
            {PUBLIC_SITE.contactEmail}
          </ExternalLink>
          .
        </Paragraph>
        <Paragraph>
          See also the{" "}
          <InternalLink href={PUBLIC_SITE.paths.privacy}>privacy policy</InternalLink>{" "}
          and the{" "}
          <InternalLink href={PUBLIC_SITE.paths.terms}>terms of service</InternalLink>
          .
        </Paragraph>
      </Section>
    </article>
  );
}
