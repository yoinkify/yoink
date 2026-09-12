import { withRequestLogging } from "@/lib/request-logging";
import { NextResponse } from "next/server";
import { getTrending } from "@/lib/spotify";

async function handleGET() {
  try {
    const songs = await getTrending(10);
    return NextResponse.json({ songs });
  } catch {
    return NextResponse.json({ songs: [] });
  }
}

export const GET = withRequestLogging(handleGET, "api.trending.started");
