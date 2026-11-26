---
name: aicw-gadgets-dev
description: "Flash, set up and talk to AICW voice gadgets (Dou on an M5Stack StickS3 and other ESP32 boards) from your own AICoworker. Use when the user opens the AICW Gadgets app or asks about it."
---

# AICW Gadgets

An AI App (`app.json`): the page is `assets/app.html`, the backend is `backend/` and runs
with no model turn. The user opens it from **AI Apps**; you are its assistant.

## Working with the app

- Run its backend with the `app` tool instead of redoing its work by hand:
  `{"action":"list"}` shows the commands it offers you; `{"action":"call","id":"app-aicw-gadgets-dev","name":"<command>","args":{…}}` runs one.
- Change what the page shows with the `artifact` tool on id `app-aicw-gadgets-dev`
  (`data` to push values, `update` to change the page). Never open a second window.

## When a message arrives from the page

A user message starting with `[artifact-reply: AICW Gadgets]` was sent by the page
(`aicw.send`). Handle it as a request about this app.
