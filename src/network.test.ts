// @vitest-environment happy-dom
// The browser environment's network, refused by vitest.setup.ts for a test
// that has not stubbed it: fetch, and happy-dom's XMLHttpRequest,
// navigator.sendBeacon and stylesheet loads, which use its own fetch. A local
// server stands in for the network and counts what reaches it.

import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";

const server = createServer((_req, res) => {
  hits++;
  res.end("real");
});
let hits = 0;
let origin = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

it("refuses fetch", async () => {
  const res = await fetch(`${origin}/fetch`);
  expect(res.status).toBe(400);
  expect(await res.text()).toBe("no fetch stub installed");
  expect(hits).toBe(0);
});

it("refuses XMLHttpRequest, async and sync", async () => {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${origin}/xhr`);
  const loaded = new Promise((resolve) => xhr.addEventListener("loadend", resolve));
  xhr.send("batch");
  await loaded;
  expect([xhr.status, xhr.responseText]).toEqual([400, "no fetch stub installed"]);

  const sync = new XMLHttpRequest();
  sync.open("GET", `${origin}/xhr-sync`, false);
  sync.send();
  expect([sync.status, sync.responseText]).toEqual([400, "no fetch stub installed"]);
  expect(hits).toBe(0);
});

it("refuses navigator.sendBeacon", async () => {
  navigator.sendBeacon(`${origin}/beacon`, "batch");
  // A beacon is fire-and-forget; give a real one time to arrive.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(hits).toBe(0);
});

// happy-dom logs the refused load to the console, outside vitest's capture.
it("refuses a stylesheet load", async () => {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${origin}/style.css`;
  const settled = new Promise<Event>((resolve) => {
    link.addEventListener("load", resolve);
    link.addEventListener("error", resolve);
  });
  document.head.appendChild(link);
  expect((await settled).type).toBe("error");
  expect(hits).toBe(0);
});
