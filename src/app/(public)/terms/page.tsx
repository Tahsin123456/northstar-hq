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
 * Terms of service.
 *
 * Google does not require this document to publish an OAuth app — the publish
 * gate asks only for an app name, a support email, a homepage and a privacy
 * policy. The YouTube API Services Developer Policies do require it, and
 * specifically require that an API client state in its own terms of use that
 * users of the client agree to be bound by the YouTube Terms of Service. That
 * sentence, and the link beside it, are the reason this page exists at all.
 *
 * Everything else here is kept deliberately short. This is an internal tool
 * with a handful of users who all work for the same company; inventing
 * arbitration clauses and limitation-of-liability boilerplate for a staff
 * dashboard would be padding, and padding in a legal document is how a reader
 * stops reading and misses the parts that are true.
 */
export const metadata: Metadata = {
  title: "Terms of service",
  description: `The terms under which ${BRAND.company} staff use ${BRAND.product}.`,
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <article>
      <DocumentTitle
        title="Terms of service"
        intro={
          <>
            {BRAND.product} is an internal tool operated by {BRAND.company} for its own
            staff. These are the terms on which it is used.
          </>
        }
        updated={{ label: PUBLIC_SITE.lastUpdated, iso: PUBLIC_SITE.lastUpdatedIso }}
      />

      <Section title="Who these terms apply to">
        <Paragraph>
          People employed by or contracted to {BRAND.company} who have been given an account.
          There is no public sign-up and no self-service registration, so if you do not have
          an account issued by an administrator at the studio, these terms do not create one
          for you.
        </Paragraph>
      </Section>

      <Section title="Your account">
        <Bullets>
          <li>
            Accounts are created by invitation from an administrator and belong to one person
            each. Do not share your password or let anyone else use your session.
          </li>
          <li>
            Tell {BRAND.company} immediately if you think somebody else has access to your
            account.
          </li>
          <li>
            Sign-ins, permission changes and other security-significant actions are recorded
            in an audit log.
          </li>
        </Bullets>
      </Section>

      <Section title="Using it">
        <Paragraph>
          Use {BRAND.product} for {BRAND.company}&apos;s work and nothing else. What you can
          see in it — channel performance, revenue, pay information and internal research —
          is the studio&apos;s confidential business information. Do not copy it out, publish
          it, or pass it to anyone outside the studio without permission.
        </Paragraph>
        <Paragraph>
          Do not attempt to reach data your account is not entitled to, and do not try to
          work around the permission system. Access is granted by role and by assigned niche,
          and is enforced on the server.
        </Paragraph>
      </Section>

      <Section title="YouTube">
        <Paragraph>
          {BRAND.product} uses YouTube API Services. By using {BRAND.product} you agree to be
          bound by the{" "}
          <ExternalLink href="https://www.youtube.com/t/terms">
            YouTube Terms of Service
          </ExternalLink>
          . Google&apos;s handling of information is described in the{" "}
          <ExternalLink href="https://www.google.com/policies/privacy">
            Google Privacy Policy
          </ExternalLink>
          , and a connected Google account&apos;s access can be revoked at any time from the{" "}
          <ExternalLink href="https://myaccount.google.com/permissions">
            Google Account permissions page
          </ExternalLink>
          .
        </Paragraph>
      </Section>

      <Section title="The numbers are estimates">
        <Paragraph>
          View counts, revenue and everything derived from them come from YouTube and are
          reported as YouTube reports them. YouTube revises figures — particularly revenue —
          after the fact, and data is collected on a schedule rather than continuously, so
          what you see may lag or later change. Treat {BRAND.product} as the studio&apos;s
          working view of its performance, not as an accounting record of last resort.
        </Paragraph>
        <Paragraph>
          The tool is provided as-is to staff, with no guarantee of availability. It depends
          on Google&apos;s APIs, which have their own quotas and outages.
        </Paragraph>
      </Section>

      <Section title="Ending access">
        <Paragraph>
          {BRAND.company} can suspend or deactivate an account at any time, and does so as a
          matter of routine when someone leaves. Deactivating an account ends access
          immediately; the payroll and audit records that account is part of are kept, as
          described in the{" "}
          <InternalLink href={PUBLIC_SITE.paths.privacy}>privacy policy</InternalLink>.
        </Paragraph>
      </Section>

      <Section title="Changes">
        <Paragraph>
          These terms change when the tool does. The date at the top is updated when they do.
        </Paragraph>
      </Section>

      <Section title="Contact">
        <Paragraph>
          {BRAND.company} operates {BRAND.product}. Questions about these terms go to{" "}
          <ExternalLink href={`mailto:${PUBLIC_SITE.contactEmail}`}>
            {PUBLIC_SITE.contactEmail}
          </ExternalLink>
          . See also the{" "}
          <InternalLink href={PUBLIC_SITE.paths.privacy}>privacy policy</InternalLink> and the{" "}
          <InternalLink href={PUBLIC_SITE.paths.about}>about page</InternalLink>.
        </Paragraph>
      </Section>
    </article>
  );
}
