# Matri-Kavach MVP

Route it. Ready it. Close it. Health-a-thon 2026, team InnoVerse (code I44UEW), Maternal Health track.

A referral routing service for maternal emergencies. A PHC nurse starts a heavy-bleeding referral, the system picks the nearest hospital whose doctor-signed checklist is all yes for this shift, tells the ambulance, asks the hospital to confirm within 2 minutes, calls the duty phone if there is no reply, reroutes if there is still no answer, and records the outcome. **All data is synthetic. No real hospital, patient or family is involved.**

## For judges (no login)

Open https://matri-kavach.onrender.com/chat (WhatsApp-style view, recommended) or the dashboard at https://matri-kavach.onrender.com/. Each visitor gets a private session that sends nothing to real phones. Tap *How to test* or *Auto-play* for a guided run.

1. Nurse chat: pick *Heavy bleeding after delivery* (or type `BLEED B+`), fill the short form, then *SEND*.
2. The proposal shows the hospital, the ETA and *Last readiness check: time, by whom*. That time comes from the hospital's latest saved shift check-in. A check-in older than 8 hours is shown as old and unconfirmed. A check-in is never shown as confirmed availability: only the hospital's reply for this case confirms.
3. Hospital duty phone: tap *1 All ready*, or wait 2 minutes to see the automated call and the reroute.
4. Doctor, blood bank, 108 driver and EMT, family and district chats show what each person gets.
5. Nurse chat: arrival check, close the loop, discharge back-referral. The district view shows the KPIs.

Use the *No hospital ready* scenario to see the fallback: "No hospital has confirmed readiness. District emergency escalation initiated. Medical college proposed as tertiary fallback, subject to clinical coordination and state referral protocols." The medical college is only proposed. Until it replies Yes, no doctor, family or blood bank message goes out and no arrival step is shown. If it says No, the district and clinicians coordinate the destination.

Emergency types: heavy bleeding (checklist signed by the clinical partner) and fits / eclampsia (reviewed by the clinical partner, pending obstetrician validation, and the app says so). Obstructed labour and others tell the nurse to call the doctor and are not routed.

The call screen in `/chat` is labelled *Automated call (demo)*. The demo makes no encryption or security claim.

## How routing works (plain code, no AI)

`src/engine.js` is a set of pure functions. A hospital is a candidate only if every checklist item for that emergency is yes in its current shift check-in. No check-in this shift means *uncertain*, never routed as ready. A hospital marked Full is skipped. Candidates are sorted by travel time, `round(km / 30 * 60 * 1.4)` minutes. The first is proposed, SEND tells 108 at once and starts a 120 second timer for the hospital, no reply means an automated call, no answer or "not available" means the next candidate and a fresh timer. If no candidate is left, district emergency escalation starts and the medical college is proposed as the tertiary fallback, which must still confirm. The same inputs always give the same route (tested).

## Simulation (synthetic, in `sim/`)

- `sim/Matri-Kavach_v3_simulation.py` and its output `sim/sim.json`: the original 20,000-case estimate. It tests a probability-ranked "confirm while driving" policy, which is **not** the exact MVP algorithm.
- `sim/mvp_engine_sim.js` and its output `sim/mvp_engine_sim.json`: the same synthetic district, but the hospital choice, reroutes and fallback come from the real `src/engine.js`. Run `node sim/mvp_engine_sim.js`.

Both use made-up hospital positions and readiness rates. They are estimates, not trial results.

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
