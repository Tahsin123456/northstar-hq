import type { Metadata } from "next";

import {
  Bullets,
  DocumentTitle,
  ExternalLink,
  InternalLink,
  Paragraph,
  Section,
  Term,
} from "@/components/public/document";
import { BRAND } from "@/lib/brand";
import { PUBLIC_SITE } from "@/lib/public-site";

/**
 * The privacy policy.
 *
 * Written against the actual schema and services rather than from a template,
 * because a template would have got at least three things wrong about this
 * particular application and every one of them matters:
 *
 *   1. Google OAuth here is not a sign-in method. Staff authenticate with an
 *      email and a password; the Google grant exists so the studio can read
 *      its own channels. A policy that said "sign in with Google" would be
 *      describing an application that does not exist.
 *   2. Disconnecting revokes the grant and deletes the stored tokens, but the
 *      view counts and revenue figures already collected stay in the database.
 *      ChannelRevenueDay deliberately holds no foreign key back to the
 *      connection so that history survives disconnection. Claiming that
 *      disconnecting erases everything would be the single most misleading
 *      sentence this document could contain.
 *   3. Retention is split, and the split is the interesting part. The business
 *      history — view counts, channels, videos, revenue days — has no expiry
 *      and is never purged. The security records do: `runHousekeeping` in
 *      sync-service.ts runs on the hourly Vercel cron and hard-deletes audit
 *      events older than 365 days (`pruneAuditEvents`), sessions dead for more
 *      than 30 days (`pruneDeadSessions`) and spent rate-limit buckets
 *      (`pruneRateLimits`). Claiming a blanket "we keep everything forever"
 *      would be false about the audit log, and claiming a tidy retention
 *      schedule would be false about the view history. It is genuinely both.
 *
 * If any of those three ever change, this page changes with them. It is a
 * description of how the system behaves, not marketing copy.
 */
export const metadata: Metadata = {
  title: "Privacy policy",
  description: `How ${BRAND.product} handles Google user data, staff account data and studio business data.`,
  robots: { index: true, follow: true },
};

/**
 * The scopes requested in src/server/services/youtube-oauth-service.ts.
 *
 * Listed verbatim rather than paraphrased, because a reviewer compares this
 * list against the consent screen character for character, and because a
 * reader deserves to see the actual permission rather than a friendly summary
 * of it. If the OAUTH_SCOPES constant in that service changes, this array is
 * wrong until it changes too.
 */
const SCOPES = [
  {
    scope: "https://www.googleapis.com/auth/youtube.readonly",
    reason:
      "Read the studio's channels and the videos on them: titles, descriptions, thumbnails, durations, publish dates, and the public view, like and comment counts. This is what the performance dashboards are built from.",
  },
  {
    scope: "https://www.googleapis.com/auth/yt-analytics.readonly",
    reason:
      "Read the studio's own YouTube Analytics for those channels, which is not public and is available only to the account that owns the channel.",
  },
  {
    scope: "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
    reason:
      "Read estimated day-by-day revenue for the studio's own channels, so earnings can be reconciled against output. Three figures are requested: estimated revenue, estimated ad revenue and estimated YouTube Premium revenue.",
  },
  {
    scope: "openid",
    reason:
      "Identify which Google account granted the connection, so an administrator looking at the settings screen can tell whose authorisation the data is flowing under.",
  },
  {
    scope: "email",
    reason:
      "Show the email address of that Google account beside the connection, for the same reason: so a connection can be recognised, and disconnected if it is the wrong account.",
  },
] as const;

export default function PrivacyPage() {
  return (
    <article>
      <DocumentTitle
        title="Privacy policy"
        intro={
          <>
            {BRAND.product} is an internal tool operated by {BRAND.company}. This policy
            describes what it does with data from Google, what it does with data about the
            staff who use it, and what it does not do at all.
          </>
        }
        updated={{ label: PUBLIC_SITE.lastUpdated, iso: PUBLIC_SITE.lastUpdatedIso }}
      />

      <Section title="The short version">
        <Bullets>
          <li>
            {BRAND.product} reads YouTube data for {BRAND.company}&apos;s own channels, using
            read-only permission granted by an administrator at the studio. It cannot change
            anything on YouTube.
          </li>
          <li>
            Google is not used to sign in. Staff accounts use an email address and a
            password.
          </li>
          <li>
            Nothing is sold, shared with advertisers or data brokers, or used for advertising
            of any kind.
          </li>
          <li>
            There is no advertising network, analytics SDK or error-tracking service in this
            application. It talks to Google and, where the studio has configured them, to an
            email provider and to Telegram. Nothing else.
          </li>
          <li>
            Shorts can be played inside the application. Pressing play loads YouTube&apos;s
            own player, which means your browser connects to Google directly at that moment.
            Nothing loads it until you click a specific Short.
          </li>
          <li>
            Access can be withdrawn at any time from the{" "}
            <ExternalLink href="https://myaccount.google.com/permissions">
              Google Account permissions page
            </ExternalLink>
            .
          </li>
        </Bullets>
      </Section>

      <Section title="Google sign-in is not what this is">
        <Paragraph>
          Worth stating plainly, because it changes what the rest of this document means:{" "}
          {BRAND.product} has no &ldquo;Sign in with Google&rdquo; button. Staff accounts are
          created by invitation and authenticate with an email address and a password.
        </Paragraph>
        <Paragraph>
          The Google connection is a separate, administrator-only action with a single
          purpose: authorising {BRAND.product} to read {BRAND.company}&apos;s own YouTube
          channel data using the studio&apos;s own Google account, rather than being limited
          to what is public. Members of the public do not connect accounts to this
          application, because members of the public do not have accounts on it.
        </Paragraph>
      </Section>

      <Section title="What we ask Google for, and why">
        <Paragraph>
          {BRAND.product} requests these permissions and no others. Every one of them is
          read-only; no scope that can publish, edit or delete anything is requested.
        </Paragraph>
        {SCOPES.map((entry) => (
          <Term key={entry.scope} term={entry.scope}>
            {entry.reason}
          </Term>
        ))}
      </Section>

      <Section title="What we receive from Google, and store">
        <Paragraph>
          <strong className="font-medium text-foreground">About the connection itself:</strong>{" "}
          the email address and the Google account identifier (the OpenID{" "}
          <code className="font-mono text-[13px]">sub</code> claim) of the account that
          granted access, the YouTube channel it covers, the scopes actually granted, and the
          OAuth access and refresh tokens. Nothing else is read from the identity token, and
          in particular no profile, name or picture is.
        </Paragraph>
        <Paragraph>
          <strong className="font-medium text-foreground">About the channels:</strong> the
          channel ID, handle, title, custom URL, description, avatar and banner image URLs,
          country, subscriber count, total view count, video count and creation date.
        </Paragraph>
        <Paragraph>
          <strong className="font-medium text-foreground">About the videos:</strong> the
          video ID, title, description, publish date, duration, thumbnail URL, and the view,
          like and comment counts. Those three counts are also kept as a history: a row is
          appended when a count changes, which is what makes it possible to see that a Short
          is accelerating rather than only that it has a total.
        </Paragraph>
        <Paragraph>
          <strong className="font-medium text-foreground">About revenue:</strong> for the
          studio&apos;s own channels only, one row per day holding estimated revenue,
          estimated ad revenue and estimated YouTube Premium revenue, requested in US
          dollars. These figures feed the studio&apos;s internal finance and payroll records.
        </Paragraph>
      </Section>

      <Section title="What is never collected">
        <Bullets>
          <li>
            No comments. {BRAND.product} never requests comment threads, so the text of a
            comment and the identity of whoever wrote it are never retrieved or stored. Only
            the number of comments on a video is.
          </li>
          <li>
            No subscriber identities. The subscriber count is a number; who those people are
            is never requested.
          </li>
          <li>
            No viewer, audience or demographic data, and no watch history for any individual.
            One clarification, because the sentence could otherwise be read too widely: this
            is about what {BRAND.product} collects and stores. Playing a Short in the built-in
            player is a normal YouTube view, so it may appear in the watch history of
            whichever Google account the member of staff&apos;s own browser is signed in to,
            in the same way as watching it on youtube.com. {BRAND.product} neither receives
            nor records that.
          </li>
          <li>No payment card or bank details of any kind.</li>
        </Bullets>
        <Paragraph>
          A distinction worth drawing: most of the channels and videos in the database belong
          to competitors, public channels the studio watches for market context. Those are
          retrieved from the public YouTube Data API with an ordinary API key, are available
          to anyone, and involve nobody&apos;s Google account or authorisation. Only{" "}
          {BRAND.company}&apos;s own channels are read through the OAuth connection described
          above.
        </Paragraph>
      </Section>

      <Section title="How Google user data is used">
        <Paragraph>
          {BRAND.product}&apos;s use and transfer of information received from Google APIs to
          any other app will adhere to the{" "}
          <ExternalLink href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </ExternalLink>
          , including the Limited Use requirements.
        </Paragraph>
        <Paragraph>
          In practice that means the data is used only to render the performance, comparison
          and revenue screens staff open in this application, and to derive the internal
          finance and payroll figures those screens exist to support. It is not transferred
          to anyone except as described below. It is not sold or passed to advertising
          platforms, data brokers or information resellers. It is never used to serve
          advertising of any kind, including retargeting and interest-based advertising, and
          never used to assess credit-worthiness or for lending.
        </Paragraph>
        <Paragraph>
          Staff at {BRAND.company} do read this data. That is the entire purpose of the
          product, and the account holder who granted the connection is the studio itself.
          Nobody outside the studio reads it.
        </Paragraph>
        <Paragraph>
          {BRAND.product} uses YouTube API Services. Google&apos;s own handling of
          information is described in the{" "}
          <ExternalLink href="https://www.google.com/policies/privacy">
            Google Privacy Policy
          </ExternalLink>
          .
        </Paragraph>
      </Section>

      <Section title="Where it is stored, and how it is protected">
        <Paragraph>
          Data is held in a PostgreSQL database hosted by Neon on Amazon Web Services
          infrastructure in Frankfurt, Germany. The application itself runs on Vercel.
        </Paragraph>
        <Bullets>
          <li>
            OAuth access and refresh tokens are encrypted at rest with AES-256-GCM, using a
            key held only in the deployment environment and never in the database. They are
            decrypted only at the moment a request to Google is made, are never included in
            any response sent to a browser, and the token fields are explicitly redacted from
            error logs.
          </li>
          <li>
            Staff passwords are stored only as scrypt hashes. The plaintext is never stored
            and cannot be recovered from what is.
          </li>
          <li>
            Session cookies are stored only as a SHA-256 hash, so the database never holds a
            value that could be replayed as a session.
          </li>
          <li>
            Everything is served over HTTPS with HSTS, a content security policy, and framing
            disabled.
          </li>
        </Bullets>
      </Section>

      <Section title="Who inside the studio can see what">
        <Paragraph>
          Access is decided on the server, on every request, by the application&apos;s data
          access layer, rather than by hiding buttons in the interface. Two limits apply on
          top of one another: data is scoped to the organisation, and staff in niche-scoped
          roles see only the channels in the niches assigned to them. A niche-scoped account
          with no assignments sees nothing at all, which is the deliberately safe direction
          for that check to fail in.
        </Paragraph>
        <Paragraph>
          Revenue, salary and payroll figures each sit behind their own separate permission,
          because commercially sensitive numbers and personal pay are different questions
          with different answers.
        </Paragraph>
      </Section>

      <Section title="Who else the data reaches">
        <Paragraph>
          {BRAND.product} sends data to three external services and no others. Google is
          listed twice below, because data reaches it by two genuinely different routes and
          collapsing them into one entry would hide the second: everything this application
          asks for goes from its server to Google, but the embedded Shorts player is loaded
          by the reader&apos;s own browser. There is no analytics, telemetry or
          error-reporting service embedded in this application.
        </Paragraph>
        <Bullets>
          <li>
            <strong className="font-medium text-foreground">Google</strong> receives the API
            requests described above and returns the data. It is the only destination that
            receives Google user data itself — no channel, video, view or revenue figure
            obtained through the connection is sent anywhere else. One derived number does
            leave, and it is described under Telegram below.
          </li>
          <li>
            <strong className="font-medium text-foreground">
              Google again, and by a different route: the embedded Shorts player
            </strong>{" "}
            is named separately because it is a different kind of flow from everything else
            in this policy, and calling both of them &ldquo;Google&rdquo; would hide that.
            Everywhere else, this application&apos;s server asks Google for data. Here, the
            member of staff&apos;s own browser loads YouTube&apos;s player directly, so
            Google sees their IP address, their browser, which video they opened, and
            whichever Google account that browser happens to be signed in to. It can also
            store data in that browser, as YouTube does on youtube.com. None of it passes
            through {BRAND.product} and none of it is recorded here.
            <br />
            Three things limit it. It happens only when somebody clicks a specific Short to
            watch it — no page loads the player on its own, so a session that never plays
            anything never reaches it. The player is loaded from{" "}
            <ExternalLink href="https://www.youtube-nocookie.com">
              youtube-nocookie.com
            </ExternalLink>
            , which defers cookies until playback starts and keeps the view out of ad
            personalisation; it is not cookie-free, and the honest description is
            &ldquo;less&rdquo;, not &ldquo;none&rdquo;. And the browser is told to send only
            this site&apos;s address rather than the page being read, so Google is not told
            which screen of the tool the Short was opened from. The content security policy
            permits that one address to be embedded and no other.
          </li>
          <li>
            <strong className="font-medium text-foreground">
              An email provider (Resend), where the studio has configured one
            </strong>{" "}
            receives the recipient address, subject and body of exactly two kinds of message:
            an invitation to create an account, and a password reset link. No YouTube or
            revenue data is ever sent by email.
          </li>
          <li>
            <strong className="font-medium text-foreground">
              Telegram, where the studio has enabled it
            </strong>{" "}
            receives a monthly payroll summary posted to one configured chat. That message
            contains staff names, roles, salary figures and bonus totals. It contains no
            email addresses, no channel or video titles, and no view or revenue figures. It
            does contain one number derived from YouTube data: for each person, a count of
            how many of the studio&apos;s own Shorts passed the studio&apos;s internal view
            threshold in the period. That count is computed from view figures read through
            the Google connection, so it is named here rather than left to inference.
          </li>
        </Bullets>
      </Section>

      <Section title="Data about the staff who use the tool">
        <Paragraph>
          Separately from anything Google-related, the application holds what an internal
          business system needs. For each account: name, work email address and password
          hash. For each session: the IP address and browser user-agent, so an unfamiliar
          device can be recognised and signed out. And an audit record of
          security-significant actions such as sign-ins, permission changes and connection
          changes. Ordinary use, meaning pages opened and searches run, is deliberately not
          logged.
        </Paragraph>
        <Paragraph>
          For employees, the studio also records employment and pay information: salary,
          per-video bonus rates, start and end dates, payroll runs and administrator notes.
          That is visible only to accounts holding the payroll permission.
        </Paragraph>
      </Section>

      <Section title="How long it is kept">
        <Paragraph>
          It depends on what the record is, and the honest answer splits in two.
        </Paragraph>
        <Paragraph>
          The business history is kept indefinitely, unless somebody deletes it by hand.
          Channels, videos, the history of view-count snapshots and the daily revenue figures
          have no expiry and no purge job, because their value is precisely that they go back
          a long way. A chart of how a Short performed last year cannot be drawn from data
          that was thrown away.
        </Paragraph>
        <Paragraph>
          The security records do expire, and a maintenance job runs every hour to enforce
          it. Entries in the audit log are permanently deleted once they are more than 365
          days old. Sessions are permanently deleted 30 days after they expire or are
          revoked. Rate-limit counters are deleted once their window has passed. Invitations
          and password reset tokens carry their own expiry and stop working at it. None of
          this is a soft delete: the rows are removed from the database.
        </Paragraph>
      </Section>

      <Section title="Revoking access, and deletion">
        <Paragraph>
          The Google connection can be withdrawn in either of two ways, and either is enough
          on its own. An administrator can disconnect it inside {BRAND.product}, which asks
          Google to revoke the grant and then deletes the stored tokens. Or the account
          holder can revoke it directly from the{" "}
          <ExternalLink href="https://myaccount.google.com/permissions">
            Google Account permissions page
          </ExternalLink>{" "}
          (the same page is also reachable at{" "}
          <ExternalLink href="https://security.google.com/settings/security/permissions">
            security.google.com/settings/security/permissions
          </ExternalLink>
          ). After either, {BRAND.product} can no longer read anything from Google.
        </Paragraph>
        <Paragraph>
          Be clear about what that does not do. Disconnecting stops future reads and removes
          the credentials; it does not erase the channel, video and revenue figures already
          collected. Those stay in the studio&apos;s database, deliberately, because
          otherwise historical performance and finance records would vanish from the books.
        </Paragraph>
        <Paragraph>
          There is no self-service delete button. To have collected data erased, or to ask
          what is held, write to{" "}
          <ExternalLink href={`mailto:${PUBLIC_SITE.contactEmail}`}>
            {PUBLIC_SITE.contactEmail}
          </ExternalLink>{" "}
          and the studio will action it directly. When a member of staff leaves, their
          account is deactivated rather than deleted, so that the payroll and audit records
          they form part of stay intact.
        </Paragraph>
      </Section>

      <Section title="Changes to this policy">
        <Paragraph>
          If what the application does with data changes, this page changes with it and the
          date at the top is updated.
        </Paragraph>
      </Section>

      <Section title="Contact">
        <Paragraph>
          {BRAND.company} is responsible for {BRAND.product} and for the data described here.
          Questions, requests and complaints go to{" "}
          <ExternalLink href={`mailto:${PUBLIC_SITE.contactEmail}`}>
            {PUBLIC_SITE.contactEmail}
          </ExternalLink>
          . See also the{" "}
          <InternalLink href={PUBLIC_SITE.paths.terms}>terms of service</InternalLink> and
          the <InternalLink href={PUBLIC_SITE.paths.about}>about page</InternalLink>.
        </Paragraph>
      </Section>
    </article>
  );
}
