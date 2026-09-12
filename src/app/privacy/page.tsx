"use client";

import Link from "next/link";

interface Section {
  title: string;
  content: (string | React.ReactNode)[];
}

const sections: Section[] = [
  {
    title: "searches and downloads",
    content: [
      "when you search or paste a link, we process the search text, URL, and download options to find and deliver music. we send relevant search terms, links, and track details to music, metadata, and lyric providers.",
      "audio is processed on our server or in your browser. some server processing creates temporary files, which the app attempts to remove when processing ends. interrupted requests or cleanup failures can leave temporary files behind.",
      "we don't create user accounts or a personal download-history profile. we cache some links and metadata in server memory to speed up repeat requests. we also keep a total download count, without attaching individual users to it.",
    ],
  },
  {
    title: "request IDs and debugging",
    content: [
      "when something goes wrong, a request ID helps us find out why.",
      "each request gets a fresh random ID. it isn't based on your IP address or identity, and we don't reuse it to recognize you on later requests. you can share this ID with us when reporting a problem.",
      "our application logs contain timestamps, request IDs, and technical events such as which processing step failed or which HTTP status a service returned. they exclude IP addresses, search text, submitted URLs, music titles, email addresses, feedback content, and raw error messages.",
      "we normally keep these logs for six to seven days. cleanup runs automatically; if a server is offline, deletion resumes when it starts again.",
      "a random ID doesn't make a record completely anonymous. if you send us an ID, we can connect that request to your report. separate infrastructure records may also allow events to be matched by time.",
    ],
  },
  {
    title: "preventing abuse and delivering the site",
    content: [
      "we temporarily use your IP address in server memory to limit repeated requests and prevent abuse. inactive entries are normally cleared within a few minutes and are also cleared when the server restarts.",
      "Cloudflare and our hosting provider process connection information to deliver and protect the site. their infrastructure logs may include IP addresses, timestamps, requested addresses, browser information, and response codes. these records are separate from our application logs.",
    ],
  },
  {
    title: "feedback",
    content: [
      "feedback is optional. the form collects a report type, title, and description. you can also choose to include your email address, a screenshot, and browser information to help us investigate.",
      "reports and screenshots are stored in our internal Linear workspace and its file storage. we use them to investigate problems and plan improvements. if you provide an email address, we use it to follow up about your report.",
      "optional contact details and screenshots are removed within 90 days after the report is resolved. general issue text may remain in the product backlog and support history. you can email us to request correction or deletion of your submission.",
      "please leave passwords, payment details, and other sensitive information out of reports, and check screenshots for private details before uploading them.",
    ],
  },
  {
    title: "cookies and browser storage",
    content: [
      "the yoink app doesn't use analytics scripts or tracking cookies.",
      "we use local storage to remember dismissed notices and the status of feedback you've submitted. after a report, your browser saves a private status token and related timestamps. it sends that token to our server when checking the report's title and status.",
      "you can remove these values by clearing yoink's site data in your browser. this resets your notices and removes saved feedback tracking from that browser. it does not delete the report from Linear.",
    ],
  },
  {
    title: "other services",
    content: [
      "alongside Cloudflare, our host, and Linear, yoink uses third-party services for music metadata, artwork, lyrics, and audio. depending on the request, these can include Spotify, Deezer, Apple/iTunes, Tidal, YouTube or Piped, Song.link, LRCLIB, and Musixmatch.",
      "some artwork loads directly from a provider into your browser. that provider receives your IP address and browser request information. external sites you choose to visit handle your information under their own privacy policies.",
      "we don't sell personal information or share it for targeted advertising.",
    ],
  },
  {
    title: "your choices and rights",
    content: [
      "you can use downloads without submitting feedback or providing an email address.",
      "where EU or UK data protection law applies, we rely on legitimate interests to operate the service, prevent abuse, investigate errors, and handle feedback. those interests are keeping yoink reliable and responding to the people who use it.",
      "depending on applicable law and the information involved, you may have rights to access, correct, delete, or receive a portable copy of your personal information, or to restrict its use.",
      <><strong className="font-semibold text-text">{"you may also object to processing based on legitimate interests."}</strong>{" email us to exercise that right."}</>,
      <>{"send requests to "}<a href="mailto:me@yoinkify.com" className="text-lavender underline decoration-lavender/30 underline-offset-4 hover:text-mauve">{"me@yoinkify.com"}</a>{", with enough information to help us locate the relevant report or record. we may need to verify that the information relates to you. we may be unable to identify records that aren't linked to you, and we'll explain any limits that apply."}</>,
      <>{"you can also complain to your local data protection authority. in the UK, that is the "}<a href="https://ico.org.uk/make-a-complaint/" className="text-lavender underline decoration-lavender/30 underline-offset-4 hover:text-mauve">{"Information Commissioner's Office"}</a>{"."}</>,
    ],
  },
  {
    title: "children and other yoink instances",
    content: [
      "yoink is not intended for children under 13. if you believe a child under 13 has submitted personal information, contact us so we can investigate and remove it as appropriate.",
      "if you use a copy of yoink hosted by someone else, that operator is responsible for its privacy practices. this policy covers yoinkify.com.",
    ],
  },
  {
    title: "changes and contact",
    content: [
      "we'll update this policy when our practices change and show the revised date on this page. for significant changes, we'll also post a notice on the site.",
      <>{"questions or data requests: "}<a href="mailto:me@yoinkify.com" className="text-lavender underline decoration-lavender/30 underline-offset-4 hover:text-mauve">{"me@yoinkify.com"}</a>{"."}</>,
    ],
  },
];

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-grid">
      {/* Nav */}
      <nav className="border-b border-surface0/60 px-6 py-4 flex items-center justify-between backdrop-blur-sm bg-base/80 sticky top-0 z-10">
        <Link href="/" className="group">
          <span className="text-sm font-bold tracking-wider uppercase text-text group-hover:text-lavender transition-colors">
            yoink
          </span>
        </Link>
        <Link
          href="/app"
          className="btn-press text-xs text-crust bg-lavender hover:bg-mauve px-4 py-2 rounded-md font-bold uppercase tracking-wider transition-colors duration-200"
        >
          open app
        </Link>
      </nav>

      {/* Hero */}
      <section className="px-6 pt-20 sm:pt-32 pb-16 sm:pb-24 max-w-2xl mx-auto">
        <div className="space-y-6 animate-fade-in-up" style={{ opacity: 0 }}>
          <p className="text-xs text-lavender uppercase tracking-[0.3em] font-bold">
            legal
          </p>
          <h1 className="text-5xl sm:text-7xl font-bold leading-[0.95] tracking-tight text-text">
            privacy
            <br />
            <span className="text-lavender">policy.</span>
          </h1>
          <p className="text-lg text-subtext0/80 leading-relaxed max-w-md">
            no accounts. no advertising trackers. clear limits on what we
            collect and keep.
          </p>
          <p className="text-xs text-overlay0/50">
            last updated: september 7, 2026
          </p>
        </div>
      </section>

      {/* Divider */}
      <div className="max-w-2xl mx-auto px-6">
        <div className="border-t border-surface0/40" />
      </div>

      {/* TLDR banner */}
      <section className="px-6 py-12 sm:py-16 max-w-2xl mx-auto">
        <div
          className="animate-fade-in-up border border-green/20 rounded-lg p-5 bg-green/5 space-y-2"
          style={{ opacity: 0 }}
        >
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green" />
            <p className="text-sm font-bold text-green">tldr</p>
          </div>
          <p className="text-sm text-subtext0/80 leading-relaxed">
            we process your requests to deliver music, use limited diagnostics
            to fix problems, and store feedback you choose to send. we don&apos;t
            sell personal information or share it for targeted advertising.
          </p>
        </div>
      </section>

      {/* Divider */}
      <div className="max-w-2xl mx-auto px-6">
        <div className="border-t border-surface0/40" />
      </div>

      {/* Sections */}
      {sections.map((section, sectionIdx) => (
        <div key={section.title}>
          <section className="px-6 py-12 sm:py-16 max-w-2xl mx-auto">
            <div
              className="animate-fade-in-up space-y-4"
              style={{ opacity: 0, animationDelay: `${sectionIdx * 60}ms` }}
            >
              <div className="flex items-baseline gap-4">
                <span className="text-2xl font-bold text-surface2">
                  {String(sectionIdx + 1).padStart(2, "0")}
                </span>
                <h2 className="text-base font-bold text-text">{section.title}</h2>
              </div>
              <div className="pl-10 sm:pl-12 space-y-3">
                {section.content.map((paragraph, i) => (
                  <p
                    key={i}
                    className="text-base text-subtext0 leading-7"
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            </div>
          </section>

          {sectionIdx < sections.length - 1 && (
            <div className="max-w-2xl mx-auto px-6">
              <div className="border-t border-surface0/30" />
            </div>
          )}
        </div>
      ))}

      {/* Divider */}
      <div className="max-w-2xl mx-auto px-6">
        <div className="border-t border-surface0/40" />
      </div>

      {/* Contact */}
      <section className="px-6 py-12 sm:py-16 max-w-2xl mx-auto">
        <div
          className="animate-fade-in-up border border-surface0/60 rounded-lg p-6 sm:p-8 bg-mantle/40 space-y-4"
          style={{ opacity: 0 }}
        >
          <p className="text-sm font-bold text-text">questions about your data?</p>
          <p className="text-sm text-subtext0/80 leading-relaxed">
            if you want a feedback submission corrected or deleted, or if you
            have questions about rate limiting or debugging logs, reach out.
          </p>
          <a
            href="mailto:me@yoinkify.com"
            className="text-sm text-lavender hover:text-mauve transition-colors duration-200 inline-block"
          >
            me@yoinkify.com
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-surface0/40 px-6 py-4 flex items-center justify-between text-xs text-overlay0/50">
        <span>yoink</span>
        <div className="flex items-center gap-3 sm:gap-4">
          <Link href="/extras" className="hover:text-text transition-colors duration-200">extras</Link>
          <Link href="/legal" className="hover:text-text transition-colors duration-200">legal</Link>
          <Link href="/source" className="hover:text-text transition-colors duration-200">source</Link>
        </div>
      </footer>
    </div>
  );
}
