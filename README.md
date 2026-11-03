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

## One-click Render setup

`render.yaml` is a Render Blueprint. On Render: New, Blueprint, pick this repo. It fills in the service name, region, build and start commands, generates `LIVE_KEY`, and asks for `DATABASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TEST_PHONE`. `TEST_PHONE` is one phone that plays the nurse, hospitals, doctor and family.

## Telegram test channel (free)

Twilio's trial WhatsApp number only sends Twilio's own templates, so for the team test the same alerts can go by Telegram. Make a bot with @BotFather, put its token in `TELEGRAM_BOT_TOKEN` on Render, and redeploy. The live page (`/?key=<LIVE_KEY>`) then shows "Connect phones on Telegram" links. Open one on a phone and tap Start. Hospital messages come with reply buttons (1 All ready, 2 15, 3 Not available). With no Twilio voice number, a second URGENT message stands in for the no-reply call. WhatsApp stays the production channel.

## WhatsApp through Meta Cloud API (free)

Twilio's trial blocked the sandbox join, so the live test uses Meta's own WhatsApp Cloud API test number, which is free for up to 5 recipient numbers. Set `WA_TOKEN` and `WA_PHONE_NUMBER_ID` on Render. In the Meta app, set the webhook Callback URL to `/meta/webhook` and the Verify token shown on the live page, and subscribe to the `messages` field. Each test phone sends one message to the test number first: free-form messages only go out inside the 24-hour window that opens. Hospital alerts arrive with three reply buttons.

## WhatsApp-style view

Open `/chat` (for example https://matri-kavach.onrender.com/chat). It shows the same referral on each person's phone as a WhatsApp-style chat with the Matri-Kavach business number: nurse, each hospital duty phone, doctor, blood bank, family, district officer, PHC and ASHA. Buttons, the patient form, the 2-minute timer and the automatic call screen all call the same server actions as the dashboard view, so the two views always show the same case. Add `?key=LIVE_KEY` to drive the live session that sends real WhatsApp messages.
