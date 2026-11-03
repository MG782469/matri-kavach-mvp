# Matri-Kavach MVP

Route it. Ready it. Close it. Health-a-thon 2026, team InnoVerse (code I44UEW), Maternal Health track.

A referral routing service for maternal emergencies. A PHC nurse starts a heavy-bleeding referral, the system picks the nearest hospital whose doctor-signed checklist is all yes for this shift, tells the ambulance, asks the hospital to confirm within 2 minutes, calls the duty phone if there is no reply, reroutes if there is still no answer, and records the outcome. **All data is synthetic. No real hospital, patient or family is involved.**

## For judges (no login)

Open the link. Each visitor gets a private session on the live server.

1. Nurse tab: tap *Heavy bleeding after delivery*, then *Send details*, then *SEND*.
2. Hospital phone tab: tap *1 All ready* (or wait 2 minutes to see the IVR call and the reroute).
3. Alerts tab: doctor summary, blood bank, family and district messages. The doctor link opens a facts-only page that expires after 2 hours.
4. Nurse tab: close the loop. District dashboard shows the closure rate.

Use *No hospital ready* to see the medical-college fallback with a district alert. *Reset* starts over.

Only the heavy-bleeding checklist is switched on, because it is the one signed by the clinical partner. Eclampsia and obstructed-labour lists are drafts and stay off.

## How routing works (plain code, no AI)

`src/engine.js` is a set of pure functions. A hospital is a candidate only if every checklist item is yes for the current shift. No check-in this shift means *uncertain*, never routed as ready. Candidates are sorted by travel time, `round(km / 30 * 60 * 1.4)` minutes. The first is proposed, SEND starts a 120 second timer, no reply means an IVR call, no answer means the next candidate and a fresh timer. If nobody is ready the medical college is the destination and the district officer is alerted. The same inputs always give the same route (tested).

## Live mode

`server/` is a Node + Express app with Postgres. Timers run on the server, so closing the browser does not stop them. Opening `/?key=<LIVE_KEY>` uses one shared *live* session whose messages really go out through Twilio to the phones set in the environment:

- SEND: WhatsApp to the proposed hospital phone.
- Hospital replies on WhatsApp: `1` all ready, `2 20` ready in 20 minutes, `3` not available.
- No reply in 120 s: a Twilio voice call to the hospital phone, press 1 for all ready.
- Confirmation: WhatsApp to the doctor (summary link), blood bank and family.
- Nurse closes the loop on screen or by replying `1/2/3` to the nurse phone.

Messages only go to the numbers in environment variables, never to a number typed in a form. Twilio webhooks are signature-checked. Without Twilio keys, or without the live key, the same flow runs with messages shown on screen only.

Webhook addresses to set in Twilio: WhatsApp sandbox "When a message comes in" = `PUBLIC_BASE_URL/twilio/whatsapp` (POST).

## Run locally

```
npm install
npm test
npm start          # http://localhost:3000, in-memory storage when DATABASE_URL is empty
```

Deploy on Render: Web Service, build `npm install`, start `npm start`, environment variables from `.env.example`.

## Static fallback

`index.html` also works as a static page (no server): it falls back to an in-browser demo with a scripted hospital.
