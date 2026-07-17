import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// ---------- Field templates: tell the AI exactly what to look for per machine brand ----------
const FIELD_TEMPLATES = {
  Ishida: `This is an Ishida "CCW Production / Total Data" checkweigher screen. Extract these fields
if visible (use null if a field is not visible in this photo):
target_weight_g, total_weight_g (see "Total Weight"), average_weight_g (see "Mean Weight"),
efficiency_pct, std_dev_g (see "S.D. Weight"), max_weight_g (see "MAX Weight"),
min_weight_g (see "MIN Weight"), count_value (see "Proper"), start_time, stop_time,
under_count, over_weight_count, over_scale_count, recheck_error_count, preset_no, product_name.`,
  Yamato: `This is a Yamato "Auto Operation" checkweigher screen (dark theme). Extract these fields
if visible (use null if a field is not visible in this photo):
target_weight_g (see "Target WT."), total_weight_g (see "Total WT."),
average_weight_g (see "Average WT."), efficiency_pct, std_dev_g (see "Std.Dev"),
max_weight_g (see "Max. WT."), min_weight_g (see "Min. WT."), count_value (see "Dump No."),
start_time, ave_head, machine_no, product_name.`,
};

// How many photos each brand's screen needs (Ishida's report scrolls across 2 screens)
const PHOTOS_REQUIRED = { Ishida: 2, Yamato: 1 };

const EXTRACTION_SYSTEM_PROMPT = `You are reading numeric values off a factory checkweigher display
photo. Respond with ONLY a raw JSON object, no markdown fences, no commentary. Use numbers (not
strings) for numeric fields, and null for anything not visible or not legible. Strip units like
"g", "%", "kg" from numeric values - just return the number. Keep any internal reasoning brief -
this is a simple reading task, not a task that needs extended analysis.`;

// Fields that get compared between local OCR and cloud re-check (numeric, tolerance-based)
const NUMERIC_FIELDS = [
  "target_weight_g", "total_weight_g", "average_weight_g", "efficiency_pct",
  "std_dev_g", "max_weight_g", "min_weight_g", "count_value",
];
function fieldsMismatch(local, cloud, tolerance = 0.05) {
  const mismatches = {};
  for (const key of NUMERIC_FIELDS) {
    const a = local?.[key], b = cloud?.[key];
    if (a == null || b == null) continue;
    const diff = Math.abs(Number(a) - Number(b));
    const base = Math.max(Math.abs(Number(a)), Math.abs(Number(b)), 1);
    if (diff / base > tolerance) mismatches[key] = { local: a, cloud: b };
  }
  return mismatches;
}

// ---------- Simple signed-token auth (no session storage needed) ----------
async function sign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function makeToken(payload, secret) {
  const body = btoa(JSON.stringify(payload));
  const sig = await sign(body, secret);
  return `${body}.${sig}`;
}

async function verifyToken(token, secret) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await sign(body, secret);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(atob(body));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function requireAuth(request, env, url) {
  const auth = request.headers.get("authorization") || "";
  let token = auth.replace(/^Bearer\s+/i, "");
  // Plain <a href> links and window.location redirects can't set headers, so also
  // accept ?token= for the routes that are triggered that way (photo view, export).
  if (!token && url) token = url.searchParams.get("token") || "";
  const payload = await verifyToken(token, env.SESSION_SECRET);
  return payload; // null if invalid/expired
}

function requireAdmin(auth) {
  return auth && auth.role === "admin";
}

// ---------- AI vision extraction (Groq — free tier, no card needed) ----------
// Groq's vision-capable model lineup changes every few months (Llama 4 Scout was
// deprecated June 17, 2026). Set GROQ_VISION_MODEL as a secret to override without a
// code change; check https://console.groq.com/docs/vision for the current model.
async function extractFromPhoto(base64Image, mediaType, machineType, env, attempt = 1) {
  const model = env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: FIELD_TEMPLATES[machineType] || FIELD_TEMPLATES.Ishida },
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64Image}` } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    // Rate limit is often transient (the free tier's per-minute budget resets fast) -
    // wait it out once before giving up, rather than immediately falling back to the
    // much less accurate on-device reader.
    if (response.status === 429 && attempt < 3) {
      const waitMatch = errText.match(/try again in ([\d.]+)s/i);
      const waitMs = waitMatch ? Math.ceil(parseFloat(waitMatch[1]) * 1000) + 500 : 3000 * attempt;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 15000)));
      return extractFromPhoto(base64Image, mediaType, machineType, env, attempt + 1);
    }
    throw new Error(`AI extraction failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("No text in AI response");

  // qwen3.6-27b (and other "thinking" models) prepend a <think>...</think> reasoning block
  // before the actual answer - strip it out, then also defensively extract just the {...}
  // JSON object in case any other stray text (code fences, commentary) slipped through.
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  cleaned = cleaned.replace(/```json|```/g, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

// ---------- Excel export (with embedded photo thumbnail per row) ----------
async function buildExcel(rows, env) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Summary");

  sheet.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Shift", key: "shift", width: 8 },
    { header: "Machine", key: "machine", width: 10 },
    { header: "Brand", key: "brand", width: 10 },
    { header: "Incharge", key: "incharge", width: 16 },
    { header: "Target Wt (g)", key: "target", width: 12 },
    { header: "Total Wt (g)", key: "total", width: 12 },
    { header: "Average Wt (g)", key: "avg", width: 13 },
    { header: "Efficiency %", key: "eff", width: 12 },
    { header: "Std Dev (g)", key: "sd", width: 11 },
    { header: "Max Wt (g)", key: "max", width: 10 },
    { header: "Min Wt (g)", key: "min", width: 10 },
    { header: "Count", key: "count", width: 9 },
    { header: "Start", key: "start", width: 11 },
    { header: "Stop", key: "stop", width: 11 },
    { header: "Corrected", key: "corrected", width: 10 },
    { header: "Photo", key: "photo", width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8A83C" } };

  const ROW_HEIGHT = 70;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const excelRow = sheet.addRow({
      date: r.reading_date, shift: r.shift, machine: r.machine_no, brand: r.machine_type,
      incharge: r.incharge_name, target: r.target_weight_g, total: r.total_weight_g,
      avg: r.average_weight_g, eff: r.efficiency_pct, sd: r.std_dev_g, max: r.max_weight_g,
      min: r.min_weight_g, count: r.count_value, start: r.start_time, stop: r.stop_time,
      corrected: r.was_corrected ? "Yes" : "No", photo: "",
    });
    excelRow.height = ROW_HEIGHT;

    // Embed a thumbnail of the first photo, if we have one and it's still in R2
    const firstKey = (r.photo_keys || "").split(",")[0];
    if (firstKey && env) {
      try {
        const obj = await env.PHOTOS.get(firstKey);
        if (obj) {
          const buf = await obj.arrayBuffer();
          const imgId = wb.addImage({ buffer: buf, extension: "jpeg" });
          // Column Q (17th, index 16) is "Photo"
          sheet.addImage(imgId, {
            tl: { col: 16.05, row: excelRow.number - 1 + 0.05 },
            ext: { width: 110, height: (ROW_HEIGHT - 8) },
          });
        }
      } catch {
        // If a photo is missing/unreadable, just leave the cell blank rather than failing export
      }
    }
  }

  // Per-brand detail sheets with every raw field the AI extracted
  for (const brand of ["Ishida", "Yamato"]) {
    const brandRows = rows.filter((r) => r.machine_type === brand);
    if (!brandRows.length) continue;
    const detail = wb.addWorksheet(`${brand} Detail`);
    const allKeys = new Set(["date", "shift", "machine", "incharge"]);
    const parsed = brandRows.map((r) => {
      let raw = {};
      try { raw = JSON.parse(r.raw_json || "{}"); } catch { /* ignore */ }
      Object.keys(raw).forEach((k) => allKeys.add(k));
      return { date: r.reading_date, shift: r.shift, machine: r.machine_no, incharge: r.incharge_name, ...raw };
    });
    const cols = [...allKeys];
    detail.columns = cols.map((k) => ({ header: k, key: k, width: 14 }));
    detail.getRow(1).font = { bold: true };
    parsed.forEach((p) => detail.addRow(p));
  }

  return wb.xlsx.writeBuffer();
}

// ---------- PDF export (photo + data per row, one block per reading) ----------
async function buildPdf(rows, env) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595.28, PAGE_H = 841.89; // A4
  const MARGIN = 36;
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const drawHeader = () => {
    page.drawText("Machine Data Report", { x: MARGIN, y, size: 16, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
    y -= 18;
    page.drawText(`Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}  |  ${rows.length} readings`,
      { x: MARGIN, y, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
    y -= 20;
  };
  drawHeader();

  const BLOCK_H = 130;

  for (const r of rows) {
    if (y - BLOCK_H < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      drawHeader();
    }

    const blockTop = y;
    // Divider line
    page.drawLine({ start: { x: MARGIN, y: blockTop + 6 }, end: { x: PAGE_W - MARGIN, y: blockTop + 6 },
      thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });

    // Photo thumbnail on the left
    const firstKey = (r.photo_keys || "").split(",")[0];
    let imgW = 90, imgH = 90;
    if (firstKey && env) {
      try {
        const obj = await env.PHOTOS.get(firstKey);
        if (obj) {
          const buf = await obj.arrayBuffer();
          const jpg = await pdf.embedJpg(buf).catch(() => null);
          const img = jpg || (await pdf.embedPng(buf).catch(() => null));
          if (img) {
            const ratio = Math.min(imgW / img.width, imgH / img.height);
            const w = img.width * ratio, h = img.height * ratio;
            page.drawImage(img, { x: MARGIN, y: blockTop - h, width: w, height: h });
          }
        }
      } catch { /* skip photo if unreadable */ }
    }

    // Data fields on the right
    const textX = MARGIN + imgW + 16;
    let ty = blockTop - 2;
    page.drawText(`${r.machine_no}  (${r.machine_type})   —   Shift ${r.shift}   —   ${r.reading_date}`,
      { x: textX, y: ty, size: 11, font: fontBold });
    ty -= 15;
    const line1 = `Target: ${fmt(r.target_weight_g)} g   Total: ${fmt(r.total_weight_g)} g   Avg: ${fmt(r.average_weight_g)} g   Efficiency: ${fmt(r.efficiency_pct)}%`;
    page.drawText(line1, { x: textX, y: ty, size: 9, font });
    ty -= 13;
    const line2 = `Std Dev: ${fmt(r.std_dev_g)} g   Max: ${fmt(r.max_weight_g)} g   Min: ${fmt(r.min_weight_g)} g   Count: ${fmt(r.count_value)}`;
    page.drawText(line2, { x: textX, y: ty, size: 9, font });
    ty -= 13;
    page.drawText(`Incharge: ${r.incharge_name}   Start: ${fmt(r.start_time)}   Stop: ${fmt(r.stop_time)}`,
      { x: textX, y: ty, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
    if (r.was_corrected) {
      ty -= 13;
      page.drawText("(values manually corrected by incharge)", { x: textX, y: ty, size: 8, font, color: rgb(0.7, 0.35, 0.2) });
    }

    y = blockTop - BLOCK_H;
  }

  return pdf.save();
}
function fmt(v) { return (v === null || v === undefined) ? "—" : v; }

// ---------- Router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Public: list of names for the login dropdown (no PINs exposed) ---
    if (path === "/api/public/users" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT name FROM users WHERE active = 1 ORDER BY name"
      ).all();
      return json(results.map((r) => r.name));
    }

    // --- Login ---
    if (path === "/api/login" && request.method === "POST") {
      const { name, pin } = await request.json();
      const user = await env.DB.prepare(
        "SELECT * FROM users WHERE name = ? AND pin = ? AND active = 1"
      ).bind(name, pin).first();
      if (!user) return json({ error: "Invalid name or PIN" }, 401);

      const token = await makeToken(
        { name: user.name, role: user.role, exp: Date.now() + 1000 * 60 * 60 * 12 },
        env.SESSION_SECRET
      );
      return json({ token, name: user.name, role: user.role });
    }

    // --- Machine list (for dropdown), includes brand + photos required ---
    if (path === "/api/machines" && request.method === "GET") {
      const auth = await requireAuth(request, env, url);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const { results } = await env.DB.prepare(
        "SELECT id, machine_no, line_name, machine_type FROM machines WHERE active = 1 ORDER BY machine_no"
      ).all();
      const withReq = results.map((m) => ({ ...m, photos_required: PHOTOS_REQUIRED[m.machine_type] || 1 }));
      return json(withReq);
    }

    // --- AI extraction (photo -> structured fields, no DB write yet) ---
    if (path === "/api/extract" && request.method === "POST") {
      const auth = await requireAuth(request, env, url);
      if (!auth) return json({ error: "Unauthorized" }, 401);

      const { images, machine_type } = await request.json();
      try {
        // Sequential, not parallel - two images fired at once can trip Groq's per-minute
        // token rate limit even when each individually is well within budget.
        const results = [];
        for (const img of images) {
          results.push(await extractFromPhoto(img.base64, img.mediaType, machine_type, env));
        }
        const merged = Object.assign({}, ...results);
        return json({ extracted: merged, perPhoto: results });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // --- Submit a reading ---
    if (path === "/api/submit" && request.method === "POST") {
      const auth = await requireAuth(request, env, url);
      if (!auth) return json({ error: "Unauthorized" }, 401);

      const body = await request.json();
      const {
        machine_id, machine_no, machine_type, shift, reading_date,
        fields, was_corrected, photos, cloud_checked, cloud_mismatch,
      } = body;

      const photoKeys = [];
      for (let i = 0; i < (photos || []).length; i++) {
        const key = `${machine_no}/${reading_date}/${shift}-${Date.now()}-${i}.jpg`;
        const bytes = Uint8Array.from(atob(photos[i].base64), (c) => c.charCodeAt(0));
        await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: photos[i].mediaType } });
        photoKeys.push(key);
      }

      await env.DB.prepare(`
        INSERT INTO readings (
          machine_id, machine_no, machine_type, shift, incharge_name, reading_date, submitted_at,
          target_weight_g, total_weight_g, average_weight_g, efficiency_pct, std_dev_g,
          max_weight_g, min_weight_g, count_value, start_time, stop_time, raw_json, photo_keys,
          was_corrected, cloud_checked, cloud_mismatch
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        machine_id, machine_no, machine_type, shift, auth.name, reading_date, new Date().toISOString(),
        fields.target_weight_g ?? null, fields.total_weight_g ?? null, fields.average_weight_g ?? null,
        fields.efficiency_pct ?? null, fields.std_dev_g ?? null, fields.max_weight_g ?? null,
        fields.min_weight_g ?? null, fields.count_value ?? null, fields.start_time ?? null,
        fields.stop_time ?? null, JSON.stringify(fields), photoKeys.join(","), was_corrected ? 1 : 0,
        cloud_checked ? 1 : 0, cloud_mismatch ? JSON.stringify(cloud_mismatch) : null
      ).run();

      return json({ ok: true });
    }

    // --- Re-check a reading against Groq using its stored photo (for offline-captured
    // readings that only had local OCR at submit time) ---
    if (path === "/api/verify" && request.method === "POST") {
      const auth = await requireAuth(request, env, url);
      if (!auth) return json({ error: "Unauthorized" }, 401);

      const { reading_id } = await request.json();
      const reading = await env.DB.prepare("SELECT * FROM readings WHERE id = ?").bind(reading_id).first();
      if (!reading) return json({ error: "Reading not found" }, 404);

      const firstKey = (reading.photo_keys || "").split(",")[0];
      if (!firstKey) return json({ error: "No photo stored for this reading" }, 400);
      const obj = await env.PHOTOS.get(firstKey);
      if (!obj) return json({ error: "Photo missing from storage" }, 404);

      const buf = await obj.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const mediaType = obj.httpMetadata?.contentType || "image/jpeg";

      try {
        const cloudExtracted = await extractFromPhoto(base64, mediaType, reading.machine_type, env);
        const local = JSON.parse(reading.raw_json || "{}");
        const mismatch = fieldsMismatch(local, cloudExtracted);
        await env.DB.prepare("UPDATE readings SET cloud_checked = 1, cloud_mismatch = ? WHERE id = ?")
          .bind(Object.keys(mismatch).length ? JSON.stringify(mismatch) : null, reading_id).run();
        return json({ ok: true, mismatch });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // --- Batch verify: re-check every unverified reading from the last N days ---
    if (path === "/api/verify-pending" && request.method === "POST") {
      const auth = await requireAuth(request, env, url);
      if (!auth) return json({ error: "Unauthorized" }, 401);

      const { results } = await env.DB.prepare(
        "SELECT id FROM readings WHERE cloud_checked = 0 AND reading_date >= date('now', '-7 days') LIMIT 50"
      ).all();

      let checked = 0, flagged = 0, errored = 0;
      const errors = [];
      for (const row of results) {
        const reading = await env.DB.prepare("SELECT * FROM readings WHERE id = ?").bind(row.id).first();
        const firstKey = (reading.photo_keys || "").split(",")[0];
        if (!firstKey) continue;
        const obj = await env.PHOTOS.get(firstKey);
        if (!obj) continue;
        try {
          const buf = await obj.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          const mediaType = obj.httpMetadata?.contentType || "image/jpeg";
          const cloudExtracted = await extractFromPhoto(base64, mediaType, reading.machine_type, env);
          const local = JSON.parse(reading.raw_json || "{}");
          const mismatch = fieldsMismatch(local, cloudExtracted);
          await env.DB.prepare("UPDATE readings SET cloud_checked = 1, cloud_mismatch = ? WHERE id = ?")
            .bind(Object.keys(mismatch).length ? JSON.stringify(mismatch) : null, row.id).run();
          checked++;
          if (Object.keys(mismatch).length) flagged++;
        } catch (err) {
          errored++;
          console.error(`verify-pending failed for reading ${row.id}:`, err.message);
          if (errors.length < 3) errors.push(err.message);
        }
      }
      return json({ checked, flagged, errored, errors });
    }

    // --- Dashboard: list readings ---
    if (path === "/api/readings" && request.method === "GET") {
      const auth = await requireAuth(request, env, url);
      if (!auth) return json({ error: "Unauthorized" }, 401);

      const dateFrom = url.searchParams.get("date_from");
      const dateTo = url.searchParams.get("date_to");
      const machineId = url.searchParams.get("machine_id");
      const shift = url.searchParams.get("shift");

      let q = "SELECT * FROM readings WHERE 1=1";
      const binds = [];
      if (dateFrom) { q += " AND reading_date >= ?"; binds.push(dateFrom); }
      if (dateTo) { q += " AND reading_date <= ?"; binds.push(dateTo); }
      if (machineId) { q += " AND machine_id = ?"; binds.push(machineId); }
      if (shift) { q += " AND shift = ?"; binds.push(shift); }
      q += " ORDER BY reading_date DESC, submitted_at DESC LIMIT 500";

      const { results } = await env.DB.prepare(q).bind(...binds).all();
      return json(results);
    }

    // --- Serve a stored photo ---
    if (path.startsWith("/api/photo/") && request.method === "GET") {
      const auth = await requireAuth(request, env, url);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const key = decodeURIComponent(path.replace("/api/photo/", ""));
      const obj = await env.PHOTOS.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: { "content-type": obj.httpMetadata?.contentType || "image/jpeg" },
      });
    }

    // --- Excel export (with embedded photo thumbnails) ---
    if (path === "/api/export" && request.method === "GET") {
      const auth = await requireAuth(request, env, url);
      if (!auth) return json({ error: "Unauthorized" }, 401);

      const rows = await getFilteredReadings(env, url);
      const buffer = await buildExcel(rows, env);

      return new Response(buffer, {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="machine-data-${new Date().toISOString().slice(0, 10)}.xlsx"`,
        },
      });
    }

    // --- PDF export (photo + data per reading) ---
    if (path === "/api/export-pdf" && request.method === "GET") {
      const auth = await requireAuth(request, env, url);
      if (!auth) return json({ error: "Unauthorized" }, 401);

      const rows = await getFilteredReadings(env, url);
      const bytes = await buildPdf(rows, env);

      return new Response(bytes, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="machine-data-${new Date().toISOString().slice(0, 10)}.pdf"`,
        },
      });
    }

    // --- Admin: machines CRUD ---
    if (path === "/api/admin/machines" && request.method === "GET") {
      const auth = await requireAuth(request, env, url);
      if (!requireAdmin(auth)) return json({ error: "Admin access required" }, 403);
      const { results } = await env.DB.prepare("SELECT * FROM machines ORDER BY machine_no").all();
      return json(results);
    }
    if (path === "/api/admin/machines" && request.method === "POST") {
      const auth = await requireAuth(request, env, url);
      if (!requireAdmin(auth)) return json({ error: "Admin access required" }, 403);
      const { machine_no, line_name, machine_type } = await request.json();
      if (!machine_no || !machine_type) return json({ error: "machine_no and machine_type required" }, 400);
      try {
        await env.DB.prepare("INSERT INTO machines (machine_no, line_name, machine_type) VALUES (?,?,?)")
          .bind(machine_no, line_name || null, machine_type).run();
        return json({ ok: true });
      } catch (e) {
        return json({ error: "Could not add machine (duplicate number?)" }, 400);
      }
    }
    if (path.startsWith("/api/admin/machines/") && request.method === "PATCH") {
      const auth = await requireAuth(request, env, url);
      if (!requireAdmin(auth)) return json({ error: "Admin access required" }, 403);
      const id = path.split("/").pop();
      const updates = await request.json();
      const fieldsAllowed = ["machine_no", "line_name", "machine_type", "active"];
      const sets = [], binds = [];
      for (const f of fieldsAllowed) {
        if (f in updates) { sets.push(`${f} = ?`); binds.push(updates[f]); }
      }
      if (!sets.length) return json({ error: "No valid fields to update" }, 400);
      binds.push(id);
      await env.DB.prepare(`UPDATE machines SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
      return json({ ok: true });
    }

    if (path.startsWith("/api/admin/machines/") && request.method === "DELETE") {
      const auth = await requireAuth(request, env, url);
      if (!requireAdmin(auth)) return json({ error: "Admin access required" }, 403);
      const id = path.split("/").pop();
      await env.DB.prepare("DELETE FROM machines WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // --- Admin: users CRUD ---
    if (path === "/api/admin/users" && request.method === "GET") {
      const auth = await requireAuth(request, env, url);
      if (!requireAdmin(auth)) return json({ error: "Admin access required" }, 403);
      const { results } = await env.DB.prepare("SELECT id, name, role, active FROM users ORDER BY name").all();
      return json(results);
    }
    if (path === "/api/admin/users" && request.method === "POST") {
      const auth = await requireAuth(request, env, url);
      if (!requireAdmin(auth)) return json({ error: "Admin access required" }, 403);
      const { name, pin, role } = await request.json();
      if (!name || !pin) return json({ error: "name and pin required" }, 400);
      try {
        await env.DB.prepare("INSERT INTO users (name, pin, role) VALUES (?,?,?)")
          .bind(name, pin, role === "admin" ? "admin" : "incharge").run();
        return json({ ok: true });
      } catch (e) {
        return json({ error: "Could not add user (duplicate name?)" }, 400);
      }
    }
    if (path.startsWith("/api/admin/users/") && request.method === "PATCH") {
      const auth = await requireAuth(request, env, url);
      if (!requireAdmin(auth)) return json({ error: "Admin access required" }, 403);
      const id = path.split("/").pop();
      const updates = await request.json();
      const fieldsAllowed = ["name", "pin", "role", "active"];
      const sets = [], binds = [];
      for (const f of fieldsAllowed) {
        if (f in updates) { sets.push(`${f} = ?`); binds.push(updates[f]); }
      }
      if (!sets.length) return json({ error: "No valid fields to update" }, 400);
      binds.push(id);
      await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
      return json({ ok: true });
    }

    if (path.startsWith("/api/admin/users/") && request.method === "DELETE") {
      const auth = await requireAuth(request, env, url);
      if (!requireAdmin(auth)) return json({ error: "Admin access required" }, 403);
      const id = path.split("/").pop();
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // --- Static frontend ---
    return env.ASSETS.fetch(request);
  },
};

async function getFilteredReadings(env, url) {
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");
  let q = "SELECT * FROM readings WHERE 1=1";
  const binds = [];
  if (dateFrom) { q += " AND reading_date >= ?"; binds.push(dateFrom); }
  if (dateTo) { q += " AND reading_date <= ?"; binds.push(dateTo); }
  q += " ORDER BY reading_date, machine_no, shift";
  const { results } = await env.DB.prepare(q).bind(...binds).all();
  return results;
}
