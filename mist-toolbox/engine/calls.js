// Ported from mist_disconnect_console.py lines 1300-1356 and 1963-1968.
// Teams / Zoom / Webex call records and the "was a call open at t" window test.

import { WINDOW_CALL_S, epochS, hexMac, num, pyGet } from "./util.js";

export function qualityPoor(q) {
  const n = num(q);
  if (n === null) return false;
  if (n > 5) return n < 50;
  return n <= 2 && n >= 0;
}

export function collabAppLabel(app) {
  const a = String(app ?? "").trim().toLowerCase();
  if (!a) return "Unknown app";
  if (a.includes("team")) return "Microsoft Teams";
  if (a.includes("zoom")) return "Zoom";
  if (a.includes("webex")) return "Webex";
  if (a.includes("skype")) return "Skype";
  return String(app);
}

export function isTeamsApp(app) {
  const a = String(app ?? "").trim().toLowerCase();
  return a.includes("team") || a.includes("skype");
}

export function pickCall(raw) {
  const app = String(raw.app || "unknown");
  const start = epochS(pyGet(raw, "start_time", raw.start));
  const end = epochS(pyGet(raw, "end_time", raw.end));
  let dur = null;
  if (start !== null && end !== null && end > start) dur = end - start;
  const audio = num(raw.audio_quality);
  const video = num(raw.video_quality);
  const screen = num(raw.screen_share_quality);
  const rating = num(raw.rating);
  return {
    app,
    appLabel: collabAppLabel(app),
    mac: hexMac(raw.mac),
    meetingId: String(raw.meeting_id || raw.meetingId || ""),
    start,
    end,
    duration: dur,
    audioQuality: audio,
    videoQuality: video,
    screenShareQuality: screen,
    rating,
    poor: qualityPoor(audio) || qualityPoor(video) || qualityPoor(rating) || qualityPoor(screen),
    teams: isTeamsApp(app),
  };
}

export function callOpenAt(call, t) {
  const tt = Number(epochS(t) || 0);
  const start = Number(epochS(call.start) || 0);
  const end = Number(epochS(call.end) || start);
  return start - WINDOW_CALL_S <= tt && tt <= end + WINDOW_CALL_S;
}
