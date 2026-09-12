import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "changelog & roadmap",
  description:
    "yoink release notes, shipped improvements, and what's planned next — docker self-hosting, downloads, metadata, and more.",
  alternates: { canonical: "/roadmap" },
};

export default function RoadmapLayout({ children }: { children: React.ReactNode }) {
  return children;
}
