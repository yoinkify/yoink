"use client";

import Link from "next/link";
import { version } from "../../package.json";

const versionLabel = `v${version.split(".").slice(0, 2).join(".")}`;

export default function Header() {
  return (
    <header className="border-b border-surface0/60 px-6 py-4 flex items-center justify-between backdrop-blur-sm bg-base/80 sticky top-0 z-10">
      <Link
        href="/"
        className="text-sm font-bold tracking-wider uppercase text-text hover:text-lavender transition-colors duration-200"
      >
        yoink
      </Link>
      <div className="flex items-center gap-2 text-xs">
        <Link href="/feedback" className="text-surface2 hover:text-lavender transition-colors duration-200">feedback</Link>
        <span className="text-surface0/60">/</span>
        <a
          href="https://github.com/yoinkify/yoink"
          target="_blank"
          rel="noopener noreferrer"
          className="text-surface2 hover:text-lavender transition-colors duration-200 animate-text-shimmer-silver"
        >
          star on github
        </a>
        <span className="text-surface0/60">|</span>
        <Link href="/roadmap#changelog" aria-label={`changelog for v${version}`} className="text-surface2 hover:text-lavender transition-colors duration-200">{versionLabel}</Link>
      </div>
    </header>
  );
}
