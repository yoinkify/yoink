import { withRequestLogging } from "@/lib/request-logging";
import { logEvent } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { createFeedbackTrackingToken } from "@/lib/feedback-tracking";
import { getLinearClient } from "@/lib/linear";
import { getClientIp } from "@/lib/request-privacy";

const TEAM_KEY = "YK";
const PROJECT_NAME = "External Feedback Intake + Linear Triage";
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

async function handlePOST(request: NextRequest) {
  try {
    // Rate limit
    const ip = getClientIp(request);
    const { allowed, retryAfter } = rateLimit(`feedback:${ip}`, 5, 60_000);
    if (!allowed) {
      return NextResponse.json(
        { error: `slow down — try again in ${retryAfter}s`, rateLimit: true },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    const formData = await request.formData();
    const type = formData.get("type") as string | null;
    const title = formData.get("title") as string | null;
    const description = formData.get("description") as string | null;
    const email = formData.get("email") as string | null;
    const browserInfo = formData.get("browserInfo") as string | null;
    const image = formData.get("image") as File | null;

    // Validate required fields
    if (!type || !["bug", "feature"].includes(type)) {
      return NextResponse.json({ error: "valid report type is required" }, { status: 400 });
    }
    if (!title?.trim()) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    if (title.length > 200) {
      return NextResponse.json({ error: "title is too long (max 200 characters)" }, { status: 400 });
    }
    if (!description?.trim()) {
      return NextResponse.json({ error: "description is required" }, { status: 400 });
    }
    if (description.length > 5000) {
      return NextResponse.json({ error: "description is too long (max 5000 characters)" }, { status: 400 });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "invalid email format" }, { status: 400 });
    }

    // Validate image if provided
    if (image) {
      if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
        return NextResponse.json({ error: "image must be png, jpg, gif, or webp" }, { status: 400 });
      }
      if (image.size > MAX_IMAGE_SIZE) {
        return NextResponse.json({ error: "image must be under 5MB" }, { status: 400 });
      }
    }

    const client = getLinearClient();

    // Find the yoinkify team
    const teams = await client.teams();
    const team = teams.nodes.find((t) => t.key === TEAM_KEY);
    if (!team) {
      logEvent("api.feedback.yoinkify_team_not_found");
      return NextResponse.json({ error: "internal configuration error" }, { status: 500 });
    }

    // Fetch states, labels, and project in parallel
    const [states, labels, projects] = await Promise.all([
      team.states(),
      team.labels(),
      client.projects({ filter: { name: { eq: PROJECT_NAME } } }),
    ]);
    const triageState = states.nodes.find((s) => s.name.toLowerCase() === "triage");
    const labelName = type === "bug" ? "Bug" : "Feature Request";
    const label = labels.nodes.find((l) => l.name === labelName);
    const project = projects.nodes[0];

    // Upload image if provided
    let imageUrl: string | null = null;
    let imageUploadFailed = false;
    if (image) {
      try {
        const arrayBuffer = await image.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const uploadPayload = await client.fileUpload(image.type, image.name, image.size);
        const uploadUrl = uploadPayload.uploadFile?.uploadUrl;
        const assetUrl = uploadPayload.uploadFile?.assetUrl;

        if (uploadUrl && assetUrl) {
          const uploadRes = await fetch(uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Type": image.type,
            },
            body: buffer,
          });
          if (uploadRes.ok) {
            imageUrl = assetUrl;
          } else {
            logEvent("api.feedback.image_upload_put_failed", uploadRes.status);
            imageUploadFailed = true;
          }
        } else {
          logEvent("api.feedback.no_upload_url_from_linear");
          imageUploadFailed = true;
        }
      } catch {
        logEvent("api.feedback.image_upload_error");
        imageUploadFailed = true;
      }
    }

    // Build issue description
    let body = description.trim();
    if (imageUrl) {
      body += `\n\n**Attached screenshot:**\n![screenshot](${imageUrl})`;
    }
    if (email) {
      body += `\n\n---\n**Reporter email:** ${email}`;
    }
    if (browserInfo) {
      body += `\n\n---\n**Browser info:** \`${browserInfo}\``;
    }
    body += `\n\n---\n*Submitted via yoinkify.com/feedback*`;

    // Create the issue
    const issuePayload = await client.createIssue({
      teamId: team.id,
      title: title.trim(),
      description: body,
      ...(triageState ? { stateId: triageState.id } : {}),
      ...(label ? { labelIds: [label.id] } : {}),
      ...(project ? { projectId: project.id } : {}),
    });

    const issue = await issuePayload.issue;
    logEvent("api.feedback.created");

    return NextResponse.json({
      success: true,
      imageUploadFailed,
      trackingToken: issue?.id ? createFeedbackTrackingToken(issue.id) : null,
      trackingUpdatedAt:
        issue?.updatedAt instanceof Date
          ? issue.updatedAt.toISOString()
          : typeof issue?.updatedAt === "string"
            ? issue.updatedAt
            : null,
    });
  } catch {
    logEvent("api.feedback.error");
    return NextResponse.json({ error: "something went wrong" }, { status: 500 });
  }
}

export const POST = withRequestLogging(handlePOST, "api.feedback.started");
