// ============================================================
// VIDEO CLIPS - "צור סרטון" button
// ============================================================
//
// Connects Postly to the video engine (postly-video on Render).
//
//   POST /video-clips        start a video (Pro / Business / owner only)
//   GET  /video-clips/:id    status of one video (owner of the video only)
//   GET  /video-clips        the user's 10 latest videos
//
// Rules (roadmap v55 + decisions of 24.11):
//   - Only plan "pro" / "business" (or role "owner") can make a video.
//   - 5 seconds = 7 credits, 8 seconds = 11 credits. Owner pays 0.
//   - Credits are RESERVED when the video starts (so the same credits can't
//     start two videos) and RETURNED once if the video fails.
//     Net result = the existing rule: failure costs nothing.
//   - Mandatory consent "the product is shown correctly", and when people
//     stay in the photo (people=keep) also "I have consent from the people".
//     The consent is stored with every video job (who, when, what).
//   - Max 2 videos in preparation per user at the same time.
//   - The SERVER follows the engine until the end - even if the app was
//     closed - saves the video to Firebase Storage (videos/), or refunds.
//     After a restart it picks up the jobs that were still in preparation.
//   - Storage: bucket lifecycle deletes videos/ after 7 days. The app gets a
//     signed link that is valid for 1 hour, only for the owner of the video.
//
// Reliability (v2, after review 25.11):
//   - Every call to the engine has a time limit (no stuck request).
//   - Any temporary error (engine or Firestore) inside the watcher is
//     retried on the next round - the watcher never stops by itself
//     before the job is ready / failed / timed out.
//   - A sweep every 5 minutes picks up any job in preparation that has no
//     active watcher (safety net), and the same runs at server start.
//
// No lost paid video (v3, needs engine 6z2):
//   - Every video gets a fixed request id (= our job id), saved BEFORE the
//     engine is called and sent to the engine as request_id. Engine 6z2
//     never starts two videos for the same request id.
//   - Credits are refunded ONLY after the engine answered clearly that it has
//     no video for this request (404 on the request id lookup) or that the
//     video failed. Any other start problem (500, timeout, no network, server
//     restart before the engine id was saved) -> we ask the engine by request
//     id; if it has the video we keep following it.
//   - No answer from the engine is not proof: we keep trying. Only after
//     NO_ANSWER_REFUND_MS (24 h) with no answer at all, the credits are
//     refunded and the job is marked manualCheck for the owner.
//   - Engine 6z1 has no request id lookup: then the video routes answer 503
//     (feature off). Checked before EVERY start (no cache), and the start
//     answer itself must echo our request_id; if it does not, the engine is
//     treated as old and the feature turns off for the next starts.
//   - (v4) Credits are never refunded while the engine says "processing".
//     After PROCESSING_ALERT_MS (1 h) the job is only marked manualCheck.
//   - (v5) Every time a job becomes manualCheck the owner gets ONE email
//     (notifyAdmin = sendAdminNotification from index.js): video id, user,
//     engine id, credits and the reason. The flag is set in a transaction
//     only if it was not set before, so there is exactly one email per video,
//     even with many watcher rounds or several server processes.
//   - (v6, 26.11) When the engine says the fal balance/quota is used up
//     (error_code "provider_quota", engine 6z4), the job is refunded as usual
//     and THEN the owner gets an email - at most one per hour (counted in this
//     server's memory: a restart can send one more). The email can never
//     block or undo the refund. The user still sees the same neutral message.
//   - (v6) POST /video-clips/test-admin-email (owner only): sends one test
//     email through the same notifyAdmin, to check that emails leave Render.
//   - (v4) "ready", "failed + refund" and "engine id found" are written in
//     transactions that first check the job is still "processing", so two
//     server processes can never both refund and deliver the same video.
//
// If VIDEO_ENGINE_URL / VIDEO_ENGINE_API_KEY are missing, the routes answer
// 503 and nothing else in the server is affected.
// ============================================================

export const VIDEO_CREDITS = { 5: 7, 8: 11 };
export const VIDEO_PLANS = ["pro", "business"];
export const MAX_ACTIVE_VIDEOS_PER_USER = 2;
export const SIGNED_URL_MS = 60 * 60 * 1000;
export const ENGINE_TIMEOUT_MS = { start: 60000, status: 20000, video: 120000 };
export const SWEEP_MS = 5 * 60 * 1000;
export const START_GRACE_MS = 2 * 60 * 1000;          // wait before asking about an unclear start
export const PROCESSING_ALERT_MS = 60 * 60 * 1000;     // engine says "processing" this long -> manualCheck (no refund)
export const NO_ANSWER_REFUND_MS = 24 * 60 * 60 * 1000; // no answer at all from the engine
export const QUOTA_EMAIL_EVERY_MS = 60 * 60 * 1000;    // v6: at most one "fal balance used up" email per hour

const JOBS = "videoJobs";

function isTrue(v) {
  return v === true || v === "true" || v === "1" || v === 1;
}

export function registerVideoRoutes({
  app,
  db,
  getBucket,
  requireAuth,
  upload,
  fetchImpl,
  FormDataImpl,
  readFile,
  removeFile,
  env = process.env,
  pollMs = 15000,
  timeoutMs = PROCESSING_ALERT_MS,
  startGraceMs = START_GRACE_MS,
  noAnswerRefundMs = NO_ANSWER_REFUND_MS,
  now = () => Date.now(),
  log = console.log,
  notifyAdmin = () => {},
  timeouts = ENGINE_TIMEOUT_MS,
  sweepMs = SWEEP_MS,
  quotaEmailEveryMs = QUOTA_EMAIL_EVERY_MS,
}) {
  const engineUrl = (env.VIDEO_ENGINE_URL || "").trim().replace(/\/+$/, "");
  const engineKey = (env.VIDEO_ENGINE_API_KEY || "").trim();
  const configured = Boolean(engineUrl && engineKey);

  if (!configured) {
    log("VIDEO: VIDEO_ENGINE_URL / VIDEO_ENGINE_API_KEY missing - video routes disabled");
  }

  const watching = new Set();
  let stopped = false;
  let lastQuotaEmailAtMs = null; // v6: in memory only
  let sweepTimer = null;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // Runs work(signal) and aborts it after ms. Used for every engine call.
  async function withTimeout(ms, label, work) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await work(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`${label} timed out after ${ms} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  const userRef = (uid) => db.collection("users").doc(uid);
  const jobRef = (id) => db.collection(JOBS).doc(id);

  // ---------- refund (once) ----------
  async function failAndRefund(jobId, reason, extra = {}) {
    const ref = jobRef(jobId);
    let refunded = 0;
    let notify = null;
    let closed = false; // v6: true only for the call that closed the job

    await db.runTransaction(async (tx) => {
      closed = false;
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const job = snap.data();
      if (job.status !== "processing" || job.refunded) return;

      const charged = job.chargedCredits || 0;
      if (charged > 0) {
        const uSnap = await tx.get(userRef(job.uid));
        const current = uSnap.exists ? uSnap.data().credits || 0 : 0;
        tx.update(userRef(job.uid), { credits: current + charged });
        refunded = charged;
      }

      const fields = {
        status: "failed",
        refunded: true,
        error: String(reason || "failed").slice(0, 300),
        updatedAtMs: now(),
        ...extra,
      };
      notify = null;
      closed = true;
      if (extra.manualCheck && !job.manualCheck) {
        fields.manualCheckReason = String(reason);
        notify = { ...job, ...fields };
      }
      tx.update(ref, fields);
    });
    if (notify) sendManualCheckEmail(jobId, notify, `${reason} (credits refunded)`);

    log(`VIDEO ${jobId}: failed (${reason}), refunded ${refunded} credits`);
    return closed;
  }

  // Writes fields only if the job is still "processing" (and not refunded).
  // Returns true if written. Used for every change of a job's outcome.
  async function updateIfProcessing(jobId, fields, extraCheck = () => true) {
    const ref = jobRef(jobId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const job = snap.data();
      if (job.status !== "processing" || job.refunded || !extraCheck(job)) return false;
      tx.update(ref, fields);
      return true;
    });
  }

  // ONE email per video, sent only by the call that set manualCheck first.
  function sendManualCheckEmail(jobId, job, reason) {
    try {
      notifyAdmin(`Video needs manual check - ${jobId}`, [
        `Time: ${new Date(now()).toISOString()}`,
        `Video id: ${jobId}`,
        `Firebase UID: ${job.uid || "-"}`,
        `Engine id: ${job.engineId || "-"}`,
        `Status: ${job.status || "-"}`,
        `Credits charged: ${job.chargedCredits ?? "-"}${job.refunded ? " (refunded)" : ""}`,
        `Reason: ${reason}`,
      ]);
    } catch (err) {
      log(`VIDEO ${jobId}: manualCheck email failed:`, err.message);
    }
  }

  // Sets manualCheck only if the job is processing and not flagged yet.
  // Sends the email only when this call is the one that set it.
  async function flagManualCheck(jobId, reason, fields = {}) {
    let flagged = null;
    await db.runTransaction(async (tx) => {
      flagged = null;
      const snap = await tx.get(jobRef(jobId));
      if (!snap.exists) return;
      const job = snap.data();
      if (job.status !== "processing" || job.refunded || job.manualCheck) return;
      const all = { ...fields, manualCheck: true, manualCheckReason: reason, updatedAtMs: now() };
      tx.update(jobRef(jobId), all);
      flagged = { ...job, ...all };
    });
    if (flagged) {
      log(`VIDEO ${jobId}: marked manualCheck - ${reason}`);
      sendManualCheckEmail(jobId, flagged, reason);
    }
    return Boolean(flagged);
  }

  // v6: the engine said the fal balance/quota is used up. Called AFTER the refund.
  // At most one email per quotaEmailEveryMs; never throws.
  function sendQuotaEmail(jobId, job) {
    try {
      if (lastQuotaEmailAtMs !== null && now() - lastQuotaEmailAtMs < quotaEmailEveryMs) {
        log(`VIDEO ${jobId}: fal balance used up - email already sent in the last hour`);
        return;
      }
      lastQuotaEmailAtMs = now();
      notifyAdmin("fal balance used up - videos are failing", [
        `Time: ${new Date(now()).toISOString()}`,
        "The video engine says the fal balance (or the fal key) was refused.",
        "Every video fails until the balance is topped up. Users get their credits back.",
        "What to do: add balance at fal.ai (Billing).",
        `Last video id: ${jobId}`,
        `Firebase UID: ${job.uid || "-"}`,
        `Engine id: ${job.engineId || "-"}`,
        `Credits refunded: ${job.chargedCredits ?? "-"}`,
        "(At most one email per hour.)",
      ]);
    } catch (err) {
      log(`VIDEO ${jobId}: fal balance email failed:`, err.message);
    }
  }

  // ---------- engine calls ----------
  function engineStatus(engineId) {
    return withTimeout(timeouts.status, "engine status", async (signal) => {
      const r = await fetchImpl(`${engineUrl}/api/v1/clips/${encodeURIComponent(engineId)}`, {
        headers: { "X-Api-Key": engineKey },
        signal,
      });
      if (r.status === 404) return { status: "lost" };
      if (!r.ok) throw new Error(`engine status ${r.status}`);
      return r.json();
    });
  }

  // Ask the engine (6z2) for the video of this request id.
  //   { found: <engine view> } | { notFound: true } | { unsupported: true }
  //   throws when there is no clear answer (network, timeout, 5xx) -> try again later.
  function engineLookup(requestId) {
    return withTimeout(timeouts.status, "engine lookup", async (signal) => {
      const r = await fetchImpl(`${engineUrl}/api/v1/clips?request_id=${encodeURIComponent(requestId)}`, {
        headers: { "X-Api-Key": engineKey },
        signal,
      });
      if (r.status === 200) {
        const view = await r.json();
        if (!view || !view.id) throw new Error("engine lookup: answer without id");
        return { found: view };
      }
      if (r.status === 404) return { notFound: true };
      if (r.status === 405) return { unsupported: true }; // engine 6z1: no GET /api/v1/clips
      throw new Error(`engine lookup ${r.status}`);
    });
  }

  // true only when the engine answers our lookup the 6z2 way (404 for an unknown id).
  // Asked before EVERY start - no cache.
  async function engineSupportsRequestId() {
    try {
      const res = await engineLookup(`probe-${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
      return Boolean(res.notFound);
    } catch (err) {
      log("VIDEO: engine capability check failed:", err.message);
      return false;
    }
  }

  async function saveVideo(jobId, job) {
    const buffer = await withTimeout(timeouts.video, "engine video", async (signal) => {
      const r = await fetchImpl(
        `${engineUrl}/api/v1/clips/${encodeURIComponent(job.engineId)}/video`,
        { headers: { "X-Api-Key": engineKey }, signal }
      );
      if (!r.ok) throw new Error(`engine video ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    });
    if (buffer.length < 1000) throw new Error(`video too small (${buffer.length} bytes)`);

    const storagePath = `videos/${job.uid}/${jobId}.mp4`;
    await getBucket()
      .file(storagePath)
      .save(buffer, { contentType: "video/mp4", resumable: false });

    return { storagePath, sizeBytes: buffer.length };
  }

  // ---------- follow one job until the end ----------
  async function watchJob(jobId) {
    if (!configured || stopped || watching.has(jobId)) return;
    watching.add(jobId);

    try {
      while (!stopped) {
        let done = false;

        try {
          done = await watchRound(jobId);
        } catch (err) {
          // Temporary error (Firestore, engine, Storage): try again next round.
          log(`VIDEO ${jobId}: temporary error, will retry:`, err.message);
        }

        if (done) return;
        await sleep(pollMs);
      }
    } finally {
      watching.delete(jobId);
    }
  }

  // One round of checks. Returns true when the job is finished
  // (ready / failed / refunded / gone) and the watcher can stop.
  async function watchRound(jobId) {
    const snap = await jobRef(jobId).get();
    if (!snap.exists) return true;
    const job = snap.data();
    if (job.status !== "processing") return true;

    const age = now() - (job.createdAtMs || 0);
    const lastAnswer = job.lastEngineAnswerAtMs || job.createdAtMs || 0;

    if (!job.engineId) {
      // The engine id was not saved (start error / timeout / server restart).
      // Wait until the start request is surely over, then ask the engine by request id.
      if (now() - (job.startAttemptAtMs || job.createdAtMs || 0) < startGraceMs) return false;

      let res;
      try {
        res = await engineLookup(jobId);
      } catch (err) {
        if (now() - lastAnswer > noAnswerRefundMs) {
          await failAndRefund(jobId, "no answer from the engine for 24 hours", { manualCheck: true });
          return true;
        }
        throw err; // temporary: try again next round
      }

      if (res.found) {
        await updateIfProcessing(
          jobId,
          { engineId: String(res.found.id), recoveredByLookup: true, lastEngineAnswerAtMs: now(), updatedAtMs: now() },
          (j) => !j.engineId
        );
        log(`VIDEO ${jobId}: found in the engine by request id, following ${res.found.id}`);
        return false; // next round follows the engine id
      }
      if (res.notFound) {
        await failAndRefund(jobId, "engine has no video for this request");
        return true;
      }
      // unsupported (engine went back to 6z1): no clear answer, keep trying.
      if (now() - lastAnswer > noAnswerRefundMs) {
        await failAndRefund(jobId, "engine cannot be asked about the request for 24 hours", { manualCheck: true });
        return true;
      }
      return false;
    }

    let s;
    try {
      s = await engineStatus(job.engineId);
    } catch (err) {
      if (now() - lastAnswer > noAnswerRefundMs) {
        await failAndRefund(jobId, "no answer from the engine for 24 hours", { manualCheck: true });
        return true;
      }
      throw err; // temporary: try again next round
    }

    if (s.status === "processing") {
      // Never refund while the engine is still working on the video.
      // Long wait -> only flag it for the owner (manualCheck), keep following.
      if (age > timeoutMs && !job.manualCheck) {
        await flagManualCheck(jobId, "engine still processing after 1 hour (no refund, still following)",
          { lastEngineAnswerAtMs: now() });
      } else if (now() - lastAnswer > 60 * 1000) {
        await updateIfProcessing(jobId, { lastEngineAnswerAtMs: now() }); // at most once a minute
      }
      return false;
    }

    if (s.status === "ready") {
      const saved = await saveVideo(jobId, job);
      const delivered = await updateIfProcessing(jobId, {
        status: "ready",
        storagePath: saved.storagePath,
        sizeBytes: saved.sizeBytes,
        costUsd: s.cost_usd ?? null,
        framing: s.framing ?? null,
        readyAtMs: now(),
        updatedAtMs: now(),
      });
      log(delivered
        ? `VIDEO ${jobId}: ready, saved ${saved.storagePath}`
        : `VIDEO ${jobId}: video ready but the job was already closed (refunded) - not delivered twice`);
      return true;
    }

    // Clear answer from the engine: "failed" (or anything that is not
    // processing / ready), or 404 for the engine id ("lost").
    const quota = s.error_code === "provider_quota"; // v6: engine 6z4
    const closedNow = await failAndRefund(jobId, s.status === "lost" ? "engine lost the job" : s.error || "engine failed",
      quota ? { engineErrorCode: "provider_quota" } : {});
    if (quota && closedNow) sendQuotaEmail(jobId, job);
    return true;
  }

  // ---------- after a restart: continue jobs in preparation ----------
  async function resumeJobs() {
    if (!configured || stopped) return 0;
    if (!sweepTimer && sweepMs > 0) {
      sweepTimer = setInterval(() => {
        resumeJobs();
      }, sweepMs);
      if (sweepTimer.unref) sweepTimer.unref();
    }
    try {
      const snap = await db.collection(JOBS).where("status", "==", "processing").get();
      snap.docs.forEach((d) => {
        watchJob(d.id);
      });
      if (snap.docs.length) log(`VIDEO: resumed ${snap.docs.length} job(s)`);
      return snap.docs.length;
    } catch (err) {
      log("VIDEO: resume error:", err.message);
      return 0;
    }
  }

  function publicJob(id, job, extra = {}) {
    return {
      id,
      status: job.status,
      seconds: job.seconds,
      credits: job.chargedCredits || 0,
      voiceover: job.voiceover,
      people: job.people,
      source: job.source,
      createdAtMs: job.createdAtMs,
      error: job.status === "failed" ? "הסרטון לא נוצר, והקרדיטים הוחזרו לחשבון שלך" : undefined,
      ...extra,
    };
  }

  // ---------- POST /video-clips/test-admin-email (v6, owner only) ----------
  // Sends ONE test email through notifyAdmin, to check that emails leave the server.
  // Works also when the video engine is not configured.
  app.post("/video-clips/test-admin-email", requireAuth, async (req, res) => {
    try {
      if ((req.userDoc || {}).role !== "owner") {
        return res.status(403).json({ error: "Owner only", code: "OWNER_ONLY" });
      }
      notifyAdmin("Test email - video alerts", [
        `Time: ${new Date(now()).toISOString()}`,
        "This is a test. If you got it, video alerts (fal balance, manual check) reach you.",
      ]);
      log("VIDEO: test admin email requested");
      res.json({ ok: true, note: "Email requested. Check the inbox, and in Render Logs look for: ADMIN EMAIL: sent" });
    } catch (error) {
      log("VIDEO TEST EMAIL ERROR:", error);
      res.status(500).json({ error: "test email failed" });
    }
  });

  // ---------- POST /video-clips ----------
  app.post("/video-clips", requireAuth, upload.single("image"), async (req, res) => {
    try {
      if (!configured) {
        return res.status(503).json({ error: "יצירת סרטונים לא זמינה כרגע", code: "VIDEO_UNAVAILABLE" });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Missing image" });
      }

      const user = req.userDoc || {};
      const isOwner = user.role === "owner";

      if (!isOwner && !VIDEO_PLANS.includes(user.plan)) {
        return res.status(403).json({
          error: "יצירת סרטונים זמינה במנוי Pro ו-Business",
          code: "PLAN_REQUIRED",
        });
      }

      const seconds = Number(req.body.seconds || 5);
      if (!VIDEO_CREDITS[seconds]) {
        return res.status(400).json({ error: "אורך הסרטון חייב להיות 5 או 8 שניות", code: "BAD_SECONDS" });
      }

      const people = req.body.people === "keep" ? "keep" : "remove";
      const voiceover = req.body.voiceover === undefined || req.body.voiceover === "" ? true : isTrue(req.body.voiceover);
      const source = req.body.source === "original" ? "original" : "background";
      const description = String(req.body.description || "").trim().slice(0, 300);

      const consentProduct = isTrue(req.body.consentProduct);
      const consentPeople = isTrue(req.body.consentPeople);

      if (!consentProduct || (people === "keep" && !consentPeople)) {
        return res.status(400).json({ error: "יש לסמן את האישורים לפני יצירת הסרטון", code: "CONSENT_REQUIRED" });
      }

      if (!(await engineSupportsRequestId())) {
        return res.status(503).json({ error: "יצירת סרטונים לא זמינה כרגע", code: "VIDEO_UNAVAILABLE" });
      }

      const cost = isOwner ? 0 : VIDEO_CREDITS[seconds];
      const newJob = jobRef(`${now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

      // Reserve credits + create the job in ONE transaction.
      const reserve = await db.runTransaction(async (tx) => {
        const active = await tx.get(
          db.collection(JOBS).where("uid", "==", req.uid).where("status", "==", "processing")
        );
        if (active.size >= MAX_ACTIVE_VIDEOS_PER_USER) return { error: "TOO_MANY" };

        const uSnap = await tx.get(userRef(req.uid));
        const credits = uSnap.exists ? uSnap.data().credits || 0 : 0;
        if (!isOwner && credits < cost) return { error: "NO_CREDITS", credits };

        if (cost > 0) tx.update(userRef(req.uid), { credits: credits - cost });

        tx.set(newJob, {
          uid: req.uid,
          status: "processing",
          seconds,
          chargedCredits: cost,
          voiceover,
          people,
          source,
          description,
          consent: {
            productShownCorrectly: true,
            peopleConsent: people === "keep" ? true : null,
            atMs: now(),
          },
          engineId: null,
          refunded: false,
          createdAtMs: now(),
          updatedAtMs: now(),
        });
        return { ok: true };
      });

      if (reserve.error === "TOO_MANY") {
        return res.status(429).json({ error: "כבר יש לך 2 סרטונים בהכנה. אפשר להתחיל סרטון חדש כשאחד מהם יסתיים", code: "TOO_MANY_ACTIVE" });
      }
      if (reserve.error === "NO_CREDITS") {
        return res.status(402).json({ error: `אין מספיק קרדיטים. סרטון של ${seconds} שניות דורש ${VIDEO_CREDITS[seconds]} קרדיטים`, code: "NO_CREDITS" });
      }

      // Send the photo to the engine, with our job id as request_id.
      // Credits are refunded only after the engine says it has no video for it.
      let started = null;
      let startedWithoutRequestId = false;
      try {
        await newJob.update({ startAttemptAtMs: now(), updatedAtMs: now() });
        const photo = await readFile(req.file.path);
        const form = new FormDataImpl();
        form.append("photo", photo, { filename: "photo.jpg", contentType: req.file.mimetype || "image/jpeg" });
        form.append("seconds", String(seconds));
        form.append("voiceover", voiceover ? "1" : "0");
        form.append("people", people);
        form.append("request_id", newJob.id);
        if (description) form.append("description", description);

        const { r, data } = await withTimeout(timeouts.start, "engine start", async (signal) => {
          const r = await fetchImpl(`${engineUrl}/api/v1/clips`, {
            method: "POST",
            headers: { "X-Api-Key": engineKey, ...form.getHeaders() },
            body: form,
            signal,
          });
          const data = await r.json().catch(() => ({}));
          return { r, data };
        });

        if (r.ok && data.id) {
          started = String(data.id);
          if (data.request_id !== newJob.id) {
            // The engine did not echo our request_id: it is an old engine (6z1).
            // Follow this video by its engine id, and note it.
            log("VIDEO START: engine did not echo request_id - old engine? following by engine id");
            startedWithoutRequestId = true;
          }
        } else {
          log(`VIDEO START: engine answered ${r.status}, asking by request id`);
          // The engine answered (the request is over): ask right away.
          try {
            const res2 = await engineLookup(newJob.id);
            if (res2.found) started = String(res2.found.id);
            else if (res2.notFound) {
              await failAndRefund(newJob.id, `engine refused the start (${r.status})`);
              return res.status(502).json({ error: "לא הצלחנו להתחיל את הסרטון. הקרדיטים לא ירדו, נסה שוב", code: "ENGINE_START_FAILED" });
            }
          } catch (lookupErr) {
            log("VIDEO START: lookup failed, the watcher will ask again:", lookupErr.message);
          }
        }
      } catch (err) {
        // Timeout / network / Firestore: unclear if the engine got it.
        log("VIDEO START unclear, the watcher will ask the engine:", err.message);
      }

      if (started) {
        try {
          await updateIfProcessing(
            newJob.id,
            { engineId: started, lastEngineAnswerAtMs: now(), updatedAtMs: now(),
              ...(startedWithoutRequestId ? { engineWithoutRequestId: true } : {}) },
            (j) => !j.engineId
          );
          if (startedWithoutRequestId) {
            await flagManualCheck(newJob.id, "engine did not echo request_id (old engine?) - followed by engine id");
          }
        } catch (err) {
          log("VIDEO START: engine id not saved, the watcher will find it by request id:", err.message);
        }
      }

      watchJob(newJob.id);

      res.json({ id: newJob.id, status: "processing", seconds, credits: cost });
    } catch (error) {
      log("VIDEO CLIPS ERROR:", error);
      res.status(500).json({ error: "שגיאה ביצירת הסרטון" });
    } finally {
      try {
        if (req.file) await removeFile(req.file.path);
      } catch (err) {
        log("File cleanup error:", err);
      }
    }
  });

  // ---------- GET /video-clips/:id ----------
  app.get("/video-clips/:id", requireAuth, async (req, res) => {
    try {
      const snap = await jobRef(String(req.params.id)).get();
      if (!snap.exists || snap.data().uid !== req.uid) {
        return res.status(404).json({ error: "הסרטון לא נמצא" });
      }
      const job = snap.data();

      if (job.status === "processing") {
        watchJob(snap.id);
        return res.json(publicJob(snap.id, job));
      }

      if (job.status === "ready") {
        const file = getBucket().file(job.storagePath);
        const [exists] = await file.exists();
        if (!exists) return res.json(publicJob(snap.id, { ...job, status: "expired" }));

        const [url] = await file.getSignedUrl({ action: "read", expires: now() + SIGNED_URL_MS });
        return res.json(publicJob(snap.id, job, { url, urlExpiresAtMs: now() + SIGNED_URL_MS }));
      }

      return res.json(publicJob(snap.id, job));
    } catch (error) {
      log("VIDEO STATUS ERROR:", error);
      res.status(500).json({ error: "שגיאה בבדיקת הסרטון" });
    }
  });

  // ---------- GET /video-clips ----------
  app.get("/video-clips", requireAuth, async (req, res) => {
    try {
      const snap = await db.collection(JOBS).where("uid", "==", req.uid).get();
      const items = snap.docs
        .map((d) => ({ id: d.id, job: d.data() }))
        .sort((a, b) => (b.job.createdAtMs || 0) - (a.job.createdAtMs || 0))
        .slice(0, 10)
        .map(({ id, job }) => publicJob(id, job));
      res.json({ videos: items });
    } catch (error) {
      log("VIDEO LIST ERROR:", error);
      res.status(500).json({ error: "שגיאה בטעינת הסרטונים" });
    }
  });

  function stop() {
    stopped = true;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  }

  return { resumeJobs, watchJob, failAndRefund, stop, configured, watching };
}
