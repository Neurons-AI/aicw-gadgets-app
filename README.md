# AICW Gadgets — AI App for AICoworker

Talk to your own AI assistant through a small voice gadget (Dou on an M5Stack StickS3 and other ESP32 boards).
This is the **AICoworker AI App** that installs the firmware, sets gadgets up and runs the voice link.
The gadget firmware lives in [Neurons-AI/aicoworker-gadgets](https://github.com/Neurons-AI/aicoworker-gadgets).

## What it does

- **My gadgets** — every gadget, online or not, which assistant it talks to; rename, change assistant, remove.
- **Add a gadget** — step by step:
  1. *New gadget:* plug it in over USB, the app installs the **AICW Gadget firmware** (esptool-js, no Python).
  2. *Already flashed:* found over **Bluetooth**; type your Wi-Fi, press the gadget's button to confirm
     (encrypted pairing, P-256 + AES-GCM), the gadget joins Wi-Fi and the AI computer.
     A wrong Wi-Fi password is asked again in the same session.
- **Conversations** — what was said and answered, per gadget.
- **Two computers** — an **AI computer** (runs the assistant, answers gadgets) and any number of
  **setup computers** (have Bluetooth, set gadgets up for it). Link with a connect code; the AI computer
  lists linked setup computers and can disconnect them or make a new code. One gadget list on both.
- **Help** — a built-in guide for non-technical users, including firmware install troubleshooting.

Voice: speech-to-text and text-to-speech run on the AI computer (on-device Whisper / Gemma and VieNeu first,
then other engines). Gadgets reach the AI computer from anywhere through the end-to-end encrypted AICW relay,
or directly on the same Wi-Fi.

## Install

Copy this folder into your AICoworker skills folder (`<workspace>/skills/aicw-gadgets-dev`), open
**AI Apps → AICW Gadgets** and press **Install** (installs `esptool-js`, `serialport` and `@stoprocent/noble`).

## Develop

```
node tests/smoke-commands.mjs     # calls every backend command with an in-memory context
```

`backend/main.mjs` — commands and the gadget bridge · `backend/relay.mjs` — AICW relay host/guest ·
`backend/ble.mjs` + `backend/pairing.mjs` — Bluetooth setup · `backend/serial.mjs` — USB flashing ·
`assets/app.html` — the window.

## License

Apache-2.0. Pairing protocol and firmware are derived from Meta's Muse Gadgets (Apache-2.0); see the firmware repo's NOTICE.
